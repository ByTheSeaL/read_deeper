package com.readdepth

import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/*
 * Everything about a lookup that doesn't touch Android: building the request,
 * reading the reply, and the channel bookkeeping. A port of the Chrome
 * extension's lib/core.js; both run the cases in shared/test-cases.json, so
 * the two clients send the model the same thing.
 */

const val OPENROUTER_BASE = "https://openrouter.ai/api/v1"
const val FALLBACK_CHANNEL = "General"

const val ROSTER_LOOKUPS_PER_CHANNEL = 6
const val PINNED_HISTORY = 15
const val SAME_SOURCE_WINDOW_MS = 6L * 60 * 60 * 1000

val REASONING_EFFORTS = listOf("low", "medium", "high", "off")

// The default model always reasons, and its hidden reasoning counts against
// max_tokens; without an allowance a short answer can come back empty.
private val REASONING_ALLOWANCE = mapOf("off" to 0, "low" to 1000, "medium" to 3000, "high" to 6000)

data class Settings(
	val apiKey          : String = "",
	val model           : String = "z-ai/glm-5.3-flash",
	val targetWords     : Int    = 80,
	val reasoningEffort : String = "low",
	val systemPrompt    : String = "",    // empty = the shared default
	val rosterSize      : Int    = 12,
	val historyLimit    : Int    = 1000
)

data class Query(
	val text        : String,
	val context     : String = "",
	val sourceUrl   : String = "",
	val sourceTitle : String = ""
)

data class Channel(
	val id         : String,
	var name       : String,
	val createdAt  : Long,
	var lastUsedAt : Long,
	val createdBy  : String? = null
)

data class Turn(val q: String, val a: String, val createdAt: Long)

data class Lookup(
	val id          : String,
	val text        : String,
	val context     : String,
	val sourceUrl   : String,
	val sourceTitle : String,
	var channelId   : String,
	val prompt      : String,
	val explanation : String,
	val gist        : String,
	val model       : String,
	val createdAt   : Long,
	val thread      : MutableList<Turn> = mutableListOf(),
	var exportName  : String = ""     // Markdown history file name, fixed at first export
)

class Data(
	val channels        : MutableList<Channel> = mutableListOf(),
	var lookups         : MutableList<Lookup> = mutableListOf(),
	var pinnedChannelId : String? = null
)

data class Message(val role: String, val content: String)

// ─── Request ────────────────────────────────────────────────────────────────

object Core {

	fun systemPromptFor(settings: Settings, defaultPrompt: String): String {
		val template = if (settings.systemPrompt.isNotBlank()) settings.systemPrompt else defaultPrompt

		return template.replace("{{target_words}}", settings.targetWords.toString())
	}

	fun maxTokensFor(settings: Settings): Int {
		val visible   = max(100, (settings.targetWords * 5.0).roundToInt())
		val reasoning = REASONING_ALLOWANCE[settings.reasoningEffort] ?: REASONING_ALLOWANCE.getValue("low")

		return visible + reasoning
	}

	fun relativeDay(ts: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
		val then = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()
		val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
		val days = ChronoUnit.DAYS.between(then, today)

		return when {
			days <= 0 -> "today"
			days == 1L -> "yesterday"
			days < 14 -> "$days days ago"
			else -> Instant.ofEpochMilli(ts).atZone(ZoneId.of("UTC")).toLocalDate().toString()   // LocalDate.ofInstant needs API 34
		}
	}

	fun relativeTime(ts: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
		val minutes = ((now - ts) / 60000.0).roundToInt()

		if (minutes < 1) return "just now"
		if (minutes < 60) return "$minutes minute${if (minutes == 1) "" else "s"} ago"

		val hours = (minutes / 60.0).roundToInt()

		if (hours < 24) return "$hours hour${if (hours == 1) "" else "s"} ago"

		return relativeDay(ts, now, zone)
	}

	fun normalizeUrl(url: String): String =
		url.trim().replace(Regex("#.*$"), "").replace(Regex("/+$"), "").lowercase()

	fun isSameSource(previous: Lookup?, current: Query, now: Long): Boolean {
		if (previous == null || now - previous.createdAt > SAME_SOURCE_WINDOW_MS) return false

		if (current.sourceUrl.isNotEmpty() && normalizeUrl(previous.sourceUrl) == normalizeUrl(current.sourceUrl)) return true

		return current.sourceTitle.isNotEmpty() && previous.sourceTitle == current.sourceTitle
	}

	/*
	 * The user message for a new lookup. forcedChannel is set when the reader
	 * has pinned a channel, or when re-explaining (which stays in the lookup's
	 * channel); otherwise the model picks from the roster.
	 */
	fun buildLookupMessage(
		query           : Query,
		data            : Data,
		forcedChannel   : String?,
		rosterSize      : Int,
		now             : Long,
		excludeLookupId : String? = null,
		zone            : ZoneId = ZoneId.systemDefault()
	): String {
		val lookups  = data.lookups.filter { it.id != excludeLookupId }
		val channels = data.channels.sortedByDescending { it.lastUsedAt }
		val out      = mutableListOf("## Channels", "")

		fun historyLines(channel: Channel, limit: Int) = lookups
			.filter { it.channelId == channel.id }
			.takeLast(limit)
			.map { "- ${oneLine(it.text, 80)}: ${it.gist}" }

		if (forcedChannel != null) {
			val channel = findChannel(data, forcedChannel)
			val lines   = if (channel != null) historyLines(channel, PINNED_HISTORY) else emptyList()

			out += "The reader has pinned the channel \"$forcedChannel\". Use exactly that name."
			out += ""
			out += "### $forcedChannel"
			out += lines.ifEmpty { listOf("(nothing looked up here yet)") }
		} else {
			val previous = lookups.lastOrNull()

			out += "Choose the channel for this lookup."

			if (previous != null) {
				val previousChannel = data.channels.find { it.id == previous.channelId }
				val same            = isSameSource(previous, query, now)

				if (previousChannel != null) {
					out += "Previous lookup: channel \"${previousChannel.name}\", ${relativeTime(previous.createdAt, now, zone)}" +
						if (same) ", from the same source as this one." else ", from a different source."
				}
			}

			val roster = channels
				.map { it to historyLines(it, ROSTER_LOOKUPS_PER_CHANNEL) }
				.filter { it.second.isNotEmpty() }
				.take(rosterSize)

			if (roster.isEmpty()) out += "The reader has no channels yet."

			for ((channel, lines) in roster) {
				out += ""
				out += "### ${channel.name} (last used ${relativeDay(channel.lastUsedAt, now, zone)})"
				out += lines
			}
		}

		if (query.sourceTitle.isNotEmpty() || query.sourceUrl.isNotEmpty()) {
			out += listOf("", "## Source")
			if (query.sourceTitle.isNotEmpty()) out += "Title: ${query.sourceTitle}"
			if (query.sourceUrl.isNotEmpty()) out += "URL: ${query.sourceUrl}"
		}

		if (query.context.isNotBlank()) {
			out += listOf("", "## Surrounding text", query.context.trim())
		}

		out += listOf("", "## Look up", query.text.trim())

		return out.joinToString("\n")
	}

	fun lookupMessages(systemPrompt: String, userMessage: String) =
		listOf(Message("system", systemPrompt), Message("user", userMessage))

	fun followUpMessages(systemPrompt: String, lookup: Lookup, channelName: String, question: String): List<Message> {
		val messages = mutableListOf(
			Message("system", systemPrompt),
			Message("user", lookup.prompt),
			Message("assistant", "CHANNEL: $channelName\n\n${lookup.explanation}")
		)

		for (turn in lookup.thread) {
			messages += Message("user", turn.q)
			messages += Message("assistant", turn.a)
		}

		messages += Message("user", question)

		return messages
	}

	// ─── Reply ──────────────────────────────────────────────────────────────

	private val CHANNEL_LINE = Regex("^[*_`#>\\s]*channel\\s*[:：]\\s*(.+?)\\s*$", RegexOption.IGNORE_CASE)

	fun cleanChannelName(raw: String?): String {
		val name = (raw ?: "")
			.replace(Regex("[*_`\"“”'‘’<>]"), "")
			.replace(Regex("[.\\s]+$"), "")
			.replace(Regex("\\s+"), " ")
			.trim()

		return name.take(60)
	}

	private val ABBREVIATIONS = Regex("(?:\\be\\.g|\\bi\\.e|\\betc|\\bvs|\\bcf|\\bapprox|\\bDr|\\bMr|\\bMs|\\bSt|\\bNo|\\bFig)\\.$", RegexOption.IGNORE_CASE)

	/* The explanation's first sentence, written by the prompt to stand alone. */
	fun gistOf(explanation: String): String {
		val plain = explanation
			.replace(Regex("```[\\s\\S]*?(```|$)"), " ")
			.replace(Regex("[*`]"), "")              // underscores stay: they're part of names like __wrapped__
			.replace(Regex("(?m)^\\s*[-•]\\s+"), "")
			.replace(Regex("\\s+"), " ")
			.trim()

		for (match in Regex("[.!?](?=\\s|$)").findAll(plain)) {
			val sentence = plain.substring(0, match.range.first + 1)

			if (!ABBREVIATIONS.containsMatchIn(sentence) && sentence.length >= 12) {
				return truncate(sentence, 220)
			}
		}

		return truncate(plain, 220)
	}

	private fun truncate(text: String, max: Int) =
		if (text.length <= max) text else text.take(max - 1).trimEnd() + "…"

	private fun oneLine(text: String, max: Int) = truncate(text.replace(Regex("\\s+"), " ").trim(), max)

	fun emptyReplyMessage(finishReason: String?) =
		if (finishReason == "length")
			"The model used its whole allowance thinking and never answered. Try again, or raise the answer length or lower the reasoning effort in settings."
		else
			"The model sent back an empty answer. Try again, or pick a different model in settings."

	fun describeHttpError(status: Int, detail: String): String {
		val suffix = if (detail.isNotEmpty()) ": $detail" else "."

		return when {
			status == 401 -> "OpenRouter rejected the API key. Check it in settings."
			status == 402 -> "Your OpenRouter account is out of credit."
			status == 403 -> "OpenRouter refused the request$suffix"
			status == 404 -> "OpenRouter doesn't know that model$suffix Pick another in settings."
			status == 408 -> "OpenRouter timed out. Try again."
			status == 429 -> "OpenRouter is rate-limiting requests. Wait a moment and try again."
			status >= 500 -> "OpenRouter or the model's provider had a problem ($status). Try again."
			else -> "OpenRouter error $status${if (detail.isNotEmpty()) ": $detail" else ""}"
		}
	}

	fun emptyData() = Data()

	fun newId(): String =
		java.lang.Long.toString(System.currentTimeMillis(), 36) + java.lang.Long.toString((Math.random() * 1e12).toLong(), 36).take(6)

	fun findChannel(data: Data, name: String): Channel? {
		val wanted = cleanChannelName(name).lowercase()

		return data.channels.find { it.name.lowercase() == wanted }
	}

	fun channelById(data: Data, id: String?): Channel? = data.channels.find { it.id == id }

	fun ensureChannel(data: Data, name: String, now: Long, createdBy: String? = null): Channel {
		findChannel(data, name)?.let { return it }

		val channel = Channel(newId(), cleanChannelName(name).ifEmpty { FALLBACK_CHANNEL }, now, now, createdBy)

		data.channels += channel

		return channel
	}

	fun pinnedChannel(data: Data): Channel? = channelById(data, data.pinnedChannelId)

	fun mostRecentChannelName(data: Data): String? =
		data.lookups.lastOrNull()?.let { channelById(data, it.channelId)?.name }

	fun addLookup(data: Data, lookup: Lookup, historyLimit: Int) {
		data.lookups.add(lookup)

		while (data.lookups.size > historyLimit) data.lookups.removeAt(0)
	}

	fun replaceLookup(data: Data, lookup: Lookup) {
		// A re-explained lookup moves to the end: it is now the most recent one.
		data.lookups.removeAll { it.id == lookup.id }
		data.lookups.add(lookup)
	}

	fun lookupById(data: Data, id: String?): Lookup? = data.lookups.find { it.id == id }

	/*
	 * Correcting a misfile: move one lookup to the named channel and pin it. A
	 * channel created for that very lookup, and now empty, is removed, so a
	 * wrong guess leaves nothing behind.
	 */
	fun moveLookup(data: Data, lookupId: String, name: String, now: Long): Channel? {
		val lookup = lookupById(data, lookupId) ?: return null
		val from   = channelById(data, lookup.channelId)
		val to     = ensureChannel(data, name, now)

		lookup.channelId     = to.id
		to.lastUsedAt        = max(to.lastUsedAt, lookup.createdAt)
		data.pinnedChannelId = to.id

		if (from != null && from.id != to.id && from.createdBy == lookup.id && data.lookups.none { it.channelId == from.id }) {
			removeChannel(data, from.id)
		}

		return to
	}

	fun renameChannel(data: Data, id: String, name: String) {
		val channel = channelById(data, id) ?: return
		val clean   = cleanChannelName(name)

		if (clean.isEmpty()) return

		val clash = findChannel(data, clean)

		if (clash != null && clash.id != id) {
			mergeChannels(data, id, clash.id)
			return
		}

		channel.name = clean
	}

	fun mergeChannels(data: Data, fromId: String, intoId: String) {
		val from = channelById(data, fromId) ?: return
		val into = channelById(data, intoId) ?: return

		if (fromId == intoId) return

		data.lookups.filter { it.channelId == fromId }.forEach { it.channelId = intoId }
		into.lastUsedAt = max(into.lastUsedAt, from.lastUsedAt)

		if (data.pinnedChannelId == fromId) data.pinnedChannelId = intoId

		removeChannel(data, fromId)
	}

	fun deleteChannel(data: Data, id: String) {
		data.lookups = data.lookups.filter { it.channelId != id }.toMutableList()
		removeChannel(data, id)
	}

	private fun removeChannel(data: Data, id: String) {
		data.channels.removeAll { it.id == id }

		if (data.pinnedChannelId == id) data.pinnedChannelId = null
	}

	data class ChannelSummary(val id: String, val name: String, val lastUsedAt: Long, val count: Int)

	fun channelSummaries(data: Data) = data.channels
		.sortedByDescending { it.lastUsedAt }
		.map { c -> ChannelSummary(c.id, c.name, c.lastUsedAt, data.lookups.count { it.channelId == c.id }) }

	/*
	 * The query box doubles as a search box, so editing it has to mean one of
	 * two things. If the new text still contains the original selection
	 * ("wraps" → "functools.wraps in tests"), it's a refinement and replaces
	 * the answer in place; anything else is a new lookup.
	 */
	fun isRefinement(originalText: String?, newText: String?): Boolean {
		val original = (originalText ?: "").trim().lowercase()
		val updated  = (newText ?: "").trim().lowercase()

		return original.isNotEmpty() && updated != original && updated.contains(original)
	}

	/*
	 * Android's share sheet hands over one string. Chrome for Android shares a
	 * selection as "“selected text”\nhttps://page#:~:text=…"; split that into
	 * the selection and the page it came from.
	 */
	fun parseShared(text: String, subject: String?): Query {
		val trimmed = text.trim()
		val match   = Regex("\\s*(https?://\\S+)\\s*$").find(trimmed)
		var body    = if (match != null) trimmed.substring(0, match.range.first) else trimmed
		val url     = match?.groupValues?.get(1) ?: ""

		if (body.isBlank()) {
			// A bare link: look up the link itself.
			body = trimmed
		}

		body = body.trim().removeSurrounding("\"").removeSurrounding("“", "”").trim()

		return Query(
			text        = body,
			sourceUrl   = if (body == trimmed) "" else url.replace(Regex("#:~:text=.*$"), ""),
			sourceTitle = subject?.trim() ?: ""
		)
	}

	// ─── Markdown history ───────────────────────────────────────────────────

	private fun yamlString(text: String) = "\"" + text
		.replace("\\", "\\\\")
		.replace("\"", "\\\"")
		.replace("\n", "\\n")
		.replace("\r", "\\r")
		.replace("\t", "\\t") + "\""

	private fun local(ts: Long, zone: ZoneId) = Instant.ofEpochMilli(ts).atZone(zone)

	/*
	 * The file name a lookup is saved under: date, time and the term, safe for
	 * every filesystem and for Obsidian links. Fixed at first export and kept
	 * on the lookup, so re-explaining it rewrites the same file.
	 */
	fun exportFileName(lookup: Lookup, zone: ZoneId = ZoneId.systemDefault()): String {
		val t    = local(lookup.createdAt, zone)
		val term = lookup.text
			.replace(Regex("[\\\\/:*?\"<>|#^\\[\\]\\u0000-\\u001f]"), " ")
			.replace(Regex("\\s+"), " ")
			.trim()
			.take(60)
			.replace(Regex("[.\\s]+$"), "")
			.ifEmpty { "lookup" }

		return String.format(java.util.Locale.ROOT, "%04d-%02d-%02d %02d%02d %s.md", t.year, t.monthValue, t.dayOfMonth, t.hour, t.minute, term)
	}

	/* A lookup, its follow-ups and its channel as a Markdown note with YAML front matter. */
	fun lookupMarkdown(lookup: Lookup, channelName: String, zone: ZoneId = ZoneId.systemDefault()): String {
		val t   = local(lookup.createdAt, zone)
		val out = mutableListOf(
			"---",
			"term: ${yamlString(lookup.text)}",
			"channel: ${yamlString(channelName)}",
			String.format(java.util.Locale.ROOT, "date: %04d-%02d-%02dT%02d:%02d", t.year, t.monthValue, t.dayOfMonth, t.hour, t.minute)
		)

		if (lookup.sourceTitle.isNotEmpty()) out += "source_title: ${yamlString(lookup.sourceTitle)}"
		if (lookup.sourceUrl.isNotEmpty()) out += "source: ${yamlString(lookup.sourceUrl)}"

		out += listOf("model: ${yamlString(lookup.model)}", "tags: [read-deeper]", "---", "", "# ${oneLine(lookup.text, 200)}", "")

		var where = "**Channel:** $channelName"

		if (lookup.sourceUrl.isNotEmpty()) where += " · **Source:** [${oneLine(lookup.sourceTitle.ifEmpty { lookup.sourceUrl }, 200)}](${lookup.sourceUrl})"
		else if (lookup.sourceTitle.isNotEmpty()) where += " · **Source:** ${oneLine(lookup.sourceTitle, 200)}"

		out += where

		if (lookup.context.isNotBlank()) out += listOf("", "> ${oneLine(lookup.context, 2000)}")

		out += listOf("", lookup.explanation.trim())

		if (lookup.thread.isNotEmpty()) {
			out += listOf("", "## Follow-ups")

			for (turn in lookup.thread) out += listOf("", "### ${oneLine(turn.q, 300)}", "", turn.a.trim())
		}

		return out.joinToString("\n") + "\n"
	}

	// ─── Rendering ──────────────────────────────────────────────────────────

	private fun escapeHtml(text: String) = buildString {
		for (c in text) {
			when (c) {
				'&' -> append("&amp;")
				'<' -> append("&lt;")
				'>' -> append("&gt;")
				'"' -> append("&quot;")
				'\'' -> append("&#39;")
				else -> append(c)
			}
		}
	}

	// Code spans are set aside first so bold can wrap them (**`x=1`**) without
	// anything inside the code being treated as Markdown.
	private fun inline(text: String): String {
		val codes = mutableListOf<String>()
		val held = Regex("`([^`\\n]+)`").replace(text) {
			codes += "<code>${escapeHtml(it.groupValues[1])}</code>"
			"\u0000${codes.size - 1}\u0000"
		}

		return escapeHtml(held)
			.replace(Regex("\\*\\*(.+?)\\*\\*"), "<strong>$1</strong>")
			.replace(Regex("(^|[^*\\w])\\*(?!\\s)(.+?)\\*(?!\\w)"), "$1<em>$2</em>")
			.replace(Regex("(^|[^_\\w])_(?!\\s)(.+?)_(?!\\w)"), "$1<em>$2</em>")
			.replace(Regex("\u0000(\\d+)\u0000")) { codes[it.groupValues[1].toInt()] }
	}

	/* The light Markdown the prompt allows: bold, italics, inline code, fenced code, lists. */
	fun markdownToHtml(markdown: String): String {
		val lines = markdown.replace("\r", "").split("\n")
		val out   = StringBuilder()
		var listTag: String? = null
		val listItems = mutableListOf<String>()
		val para = mutableListOf<String>()

		fun flushPara() {
			if (para.isNotEmpty()) out.append("<p>").append(para.joinToString("<br>") { inline(it) }).append("</p>")
			para.clear()
		}

		fun flushList() {
			val tag = listTag ?: return
			out.append("<$tag>").append(listItems.joinToString("") { "<li>${inline(it)}</li>" }).append("</$tag>")
			listTag = null
			listItems.clear()
		}

		var i = 0

		while (i < lines.size) {
			val line = lines[i]

			if (Regex("^\\s*```").containsMatchIn(line)) {
				flushPara()
				flushList()

				val code = mutableListOf<String>()

				i++
				while (i < lines.size && !Regex("^\\s*```").containsMatchIn(lines[i])) {
					code += lines[i]
					i++
				}

				out.append("<pre><code>").append(escapeHtml(code.joinToString("\n"))).append("</code></pre>")
				i++
				continue
			}

			val bullet  = Regex("^\\s*[-*•]\\s+(.*)$").find(line)
			val ordered = Regex("^\\s*\\d+[.)]\\s+(.*)$").find(line)

			if (bullet != null || ordered != null) {
				flushPara()

				val tag = if (bullet != null) "ul" else "ol"

				if (listTag != tag) {
					flushList()
					listTag = tag
				}

				listItems += (bullet ?: ordered)!!.groupValues[1]
				i++
				continue
			}

			if (line.isBlank()) {
				flushPara()
				flushList()
				i++
				continue
			}

			flushList()
			para += line.replace(Regex("^#+\\s*"), "")
			i++
		}

		flushPara()
		flushList()

		return out.toString()
	}

	/*
	 * Android's Html.fromHtml knows <b>, <i>, <tt> and lists but not <code>
	 * or <pre>, so translate the shared HTML into tags it renders.
	 */
	fun toAndroidHtml(html: String): String = html
		.replace(Regex("<pre><code>([\\s\\S]*?)</code></pre>")) { match ->
			val body = match.groupValues[1]
				.replace("\n", "<br>")
				.replace(Regex("(?<=^|<br>)( +)")) { "&nbsp;".repeat(it.value.length) }

			"<p><tt>$body</tt></p>"
		}
		.replace("<code>", "<tt>").replace("</code>", "</tt>")
		.replace("<strong>", "<b>").replace("</strong>", "</b>")
		.replace("<em>", "<i>").replace("</em>", "</i>")

	fun clamp(value: Int, lo: Int, hi: Int) = min(hi, max(lo, value))
}

/*
 * Splits a streamed reply into its CHANNEL line and the explanation. It holds
 * text back only until it can tell whether the reply opens with a CHANNEL
 * line, so the explanation still appears as it streams.
 */
class ReplyParser {

	data class Result(val channel: String? = null, val delta: String? = null)

	private var pending = ""
	private var decided = false

	var channel: String? = null
		private set

	var text = ""
		private set

	private val channelLine = Regex("^[*_`#>\\s]*channel\\s*[:：]\\s*(.+?)\\s*$", RegexOption.IGNORE_CASE)

	fun push(chunk: String): Result {
		if (decided) {
			text += chunk
			return Result(delta = chunk)
		}

		pending += chunk

		val trimmed  = pending.trimStart()
		val newline  = trimmed.indexOf('\n')
		val bareHead = trimmed.replace(Regex("^[*_`#>\\s]+"), "").take(7).lowercase()

		if (newline != -1) return decide(trimmed.substring(0, newline), trimmed.substring(newline + 1))

		// Clearly not a CHANNEL line: stop holding text back.
		if (bareHead.length == 7 && bareHead != "channel") return decide(null, trimmed)

		if (trimmed.length > 160) return decide(null, trimmed)

		return Result()
	}

	fun finish(): Result {
		if (decided) return Result()

		return decide(pending.trimStart(), "")
	}

	private fun decide(firstLine: String?, rest: String): Result {
		decided = true

		val match = firstLine?.let { channelLine.find(it) }

		when {
			match != null -> {
				channel = Core.cleanChannelName(match.groupValues[1])
				text    = rest.trimStart()
			}
			firstLine == null -> text = rest
			else -> text = if (rest.isNotEmpty()) "$firstLine\n$rest" else firstLine
		}

		return Result(channel = channel, delta = text.ifEmpty { null })
	}
}

/*
 * Reads an OpenRouter SSE stream. Feeds complete lines; keeps a partial
 * trailing line for the next chunk.
 */
class SseReader {

	data class Result(val deltas: List<String>, val error: String? = null)

	private var buffer = ""

	var done = false
		private set

	var finishReason: String? = null
		private set

	fun push(text: String): Result {
		buffer += text

		val lines  = buffer.split(Regex("\\r?\\n"))
		val deltas = mutableListOf<String>()

		buffer = lines.last()

		for (line in lines.dropLast(1)) {
			if (!line.startsWith("data:")) continue   // blank separators and ": OPENROUTER PROCESSING" keep-alives

			val payload = line.substring(5).trim()

			if (payload == "[DONE]") {
				done = true
				break
			}

			val event = try {
				org.json.JSONObject(payload)
			} catch (e: org.json.JSONException) {
				continue
			}

			event.optJSONObject("error")?.let {
				return Result(deltas, it.optString("message").ifEmpty { "The model's provider returned an error." })
			}

			val choice = event.optJSONArray("choices")?.optJSONObject(0) ?: continue
			val content = choice.optJSONObject("delta")?.let { if (it.isNull("content")) null else it.optString("content") }

			if (!content.isNullOrEmpty()) deltas += content

			if (!choice.isNull("finish_reason")) finishReason = choice.optString("finish_reason")
		}

		return Result(deltas)
	}
}
