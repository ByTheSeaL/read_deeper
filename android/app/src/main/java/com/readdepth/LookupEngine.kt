package com.readdepth

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.io.IOException
import kotlin.concurrent.thread

/*
 * Runs lookups and follow-ups: builds the prompt, streams from OpenRouter,
 * files the result into a channel, saves it. The Android counterpart of the
 * extension's background.js. Work runs on a plain background thread that
 * outlives the screen, so dismissing the dialog mid-answer still saves it.
 * Callbacks arrive on the main thread.
 */
class LookupEngine(context: Context) {

	enum class Op { LOOKUP, FOLLOWUP }

	interface Listener {
		fun onState(pinned: String?, channels: List<String>)
		fun onStart(op: Op, question: String?)
		fun onChannel(name: String)
		fun onDelta(op: Op, markdown: String)
		fun onLookupDone(lookup: Lookup, channelName: String)
		fun onFollowUpDone(turn: Turn)
		fun onError(op: Op, message: String, needsKey: Boolean)
		fun onNotice(message: String)
	}

	private val app   = context.applicationContext
	private val store = Store.get(app)
	private val main  = Handler(Looper.getMainLooper())

	@Volatile var listener: Listener? = null

	private var current: OpenRouter.Call? = null

	// Deltas arrive faster than they're worth drawing; redraw at most every 50 ms.
	private var pendingDelta: Pair<Op, String>? = null
	private var deltaScheduled = false

	private fun ui(block: Listener.() -> Unit) {
		main.post { listener?.block() }
	}

	private fun delta(op: Op, markdown: String) {
		synchronized(this) {
			pendingDelta = op to markdown
			if (deltaScheduled) return
			deltaScheduled = true
		}

		main.postDelayed({
			val next = synchronized(this) {
				deltaScheduled = false
				pendingDelta.also { pendingDelta = null }
			}

			if (next != null) listener?.onDelta(next.first, next.second)
		}, 50)
	}

	fun refreshState() {
		thread {
			val data   = store.load()
			val pinned = Core.pinnedChannel(data)?.name
			val names  = Core.channelSummaries(data).map { it.name }

			ui { onState(pinned, names) }
		}
	}

	fun cancel() {
		current?.cancel()
		current = null
	}

	private fun settingsOrError(op: Op): Settings? {
		val settings = Prefs.load(app)

		if (settings.apiKey.isEmpty()) {
			ui { onError(op, "Add your OpenRouter API key in Read Deeper's settings first.", true) }
			return null
		}

		return settings
	}

	/* A replaced (re-explained) lookup keeps its id and channel. */
	fun lookUp(query: Query, replaceLookupId: String? = null) {
		cancel()

		val call = OpenRouter.Call().also { current = it }

		thread {
			try {
				val settings = settingsOrError(Op.LOOKUP) ?: return@thread
				val data     = store.load()
				val now      = System.currentTimeMillis()
				val replaced = Core.lookupById(data, replaceLookupId)
				val pinned   = Core.pinnedChannel(data)
				val forced   = if (replaced != null) Core.channelById(data, replaced.channelId)?.name else pinned?.name

				val prompt = Core.buildLookupMessage(
					query           = query,
					data            = data,
					forcedChannel   = forced,
					rosterSize      = settings.rosterSize,
					now             = now,
					excludeLookupId = replaced?.id
				)

				val system = Core.systemPromptFor(settings, Prefs.defaultSystemPrompt(app))
				val parser = ReplyParser()
				var announced = false

				ui { onStart(Op.LOOKUP, null) }

				if (forced != null) {
					ui { onChannel(forced) }
					announced = true
				}

				val emit = { result: ReplyParser.Result ->
					if (result.channel != null && !announced) {
						ui { onChannel(result.channel) }
						announced = true
					}

					if (result.delta != null) delta(Op.LOOKUP, parser.text)
				}

				val finishReason = OpenRouter.streamChat(settings, Core.lookupMessages(system, prompt), call) { emit(parser.push(it)) }

				if (call.cancelled) return@thread

				emit(parser.finish())

				val explanation = parser.text.trim()

				if (explanation.isEmpty()) throw ApiException(Core.emptyReplyMessage(finishReason))

				val channelName = forced ?: parser.channel ?: Core.mostRecentChannelName(data) ?: FALLBACK_CHANNEL

				val (lookup, name) = store.update { fresh ->
					val id      = replaced?.id ?: Core.newId()
					val channel = Core.ensureChannel(fresh, channelName, now, id)
					val record  = Lookup(
						id          = id,
						text        = query.text,
						context     = query.context,
						sourceUrl   = query.sourceUrl,
						sourceTitle = query.sourceTitle,
						channelId   = channel.id,
						prompt      = prompt,
						explanation = explanation,
						gist        = Core.gistOf(explanation),
						model       = settings.model,
						createdAt   = now,
						exportName  = replaced?.exportName ?: ""
					)

					channel.lastUsedAt = now

					if (replaced != null) Core.replaceLookup(fresh, record) else Core.addLookup(fresh, record, settings.historyLimit)

					record to channel.name
				}

				ui { onLookupDone(lookup, name) }
				refreshState()
				exportQuietly(listOf(lookup.id))
			} catch (e: ApiException) {
				if (!call.cancelled) ui { onError(Op.LOOKUP, e.message ?: "Something went wrong.", e.needsKey) }
			} catch (e: IOException) {
				if (!call.cancelled) ui { onError(Op.LOOKUP, "Something went wrong: ${e.message}", false) }
			} catch (e: Exception) {
				ui { onError(Op.LOOKUP, "Something went wrong: ${e.message}", false) }
			}
		}
	}

	fun followUp(lookupId: String, question: String) {
		cancel()

		val call = OpenRouter.Call().also { current = it }

		thread {
			try {
				val settings = settingsOrError(Op.FOLLOWUP) ?: return@thread
				val data     = store.load()
				val lookup   = Core.lookupById(data, lookupId) ?: throw ApiException("That lookup is no longer in your history.")
				val channel  = Core.channelById(data, lookup.channelId)
				val system   = Core.systemPromptFor(settings, Prefs.defaultSystemPrompt(app))
				val messages = Core.followUpMessages(system, lookup, channel?.name ?: FALLBACK_CHANNEL, question)
				var answer   = ""

				ui { onStart(Op.FOLLOWUP, question) }

				val finishReason = OpenRouter.streamChat(settings, messages, call) {
					answer += it
					delta(Op.FOLLOWUP, stripChannelLine(answer))
				}

				if (call.cancelled) return@thread

				answer = stripChannelLine(answer).trim()

				if (answer.isEmpty()) throw ApiException(Core.emptyReplyMessage(finishReason))

				val turn = Turn(question, answer, System.currentTimeMillis())

				store.update { fresh -> Core.lookupById(fresh, lookupId)?.thread?.add(turn) }

				ui { onFollowUpDone(turn) }
				exportQuietly(listOf(lookupId))
			} catch (e: ApiException) {
				if (!call.cancelled) ui { onError(Op.FOLLOWUP, e.message ?: "Something went wrong.", e.needsKey) }
			} catch (e: Exception) {
				if (!call.cancelled) ui { onError(Op.FOLLOWUP, "Something went wrong: ${e.message}", false) }
			}
		}
	}

	/* A failed export never fails the lookup; it's reported on the panel instead. */
	private fun exportQuietly(ids: List<String>) {
		try {
			Exporter.export(app, ids)
		} catch (e: Exception) {
			ui { onNotice("Couldn't write the Markdown note: ${e.message}") }
		}
	}

	// Follow-ups shouldn't carry a CHANNEL line, but a model that adds one
	// anyway shouldn't have it shown.
	private fun stripChannelLine(text: String) =
		text.replace(Regex("^\\s*[*_`#>\\s]*channel\\s*:.*(\\n+|$)", RegexOption.IGNORE_CASE), "")

	/*
	 * Typing a channel name either moves the lookup on screen into that
	 * channel or, with none on screen, pins it for the next one. A blank
	 * name goes back to auto.
	 */
	fun setChannel(lookupId: String?, name: String) {
		thread {
			val clean = name.trim()

			store.update { data ->
				when {
					clean.isEmpty() -> data.pinnedChannelId = null
					lookupId != null && Core.lookupById(data, lookupId) != null -> Core.moveLookup(data, lookupId, clean, System.currentTimeMillis())
					else -> data.pinnedChannelId = Core.ensureChannel(data, clean, System.currentTimeMillis()).id
				}
			}

			refreshState()

			if (clean.isNotEmpty() && lookupId != null) exportQuietly(listOf(lookupId))
		}
	}

	fun pin(name: String?) {
		thread {
			store.update { data ->
				data.pinnedChannelId = if (name.isNullOrBlank()) null else Core.ensureChannel(data, name, System.currentTimeMillis()).id
			}

			refreshState()
		}
	}
}
