package com.readdepth

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.text.Html
import android.text.Spanned
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/*
 * The lookup panel (layout/view_lookup.xml): query box, channel box, streamed
 * answer, follow-up thread. The same panel is used by the dialog that opens
 * from another app and by the main screen, as in the extension.
 */
class LookupPanel(
	private val activity : Activity,
	root                 : View,
	private val onDone   : (Lookup) -> Unit = {}
) : LookupEngine.Listener {

	private val engine = LookupEngine(activity)

	private val query     = root.findViewById<EditText>(R.id.query)
	private val run       = root.findViewById<Button>(R.id.run)
	private val channel   = root.findViewById<AutoCompleteTextView>(R.id.channel)
	private val pin       = root.findViewById<Button>(R.id.pin)
	private val status    = root.findViewById<TextView>(R.id.status)
	private val answer    = root.findViewById<TextView>(R.id.answer)
	private val thread    = root.findViewById<LinearLayout>(R.id.thread)
	private val followRow = root.findViewById<View>(R.id.follow_row)
	private val follow    = root.findViewById<EditText>(R.id.follow)
	private val ask       = root.findViewById<Button>(R.id.ask)
	private val copy      = root.findViewById<Button>(R.id.copy)
	private val settings  = root.findViewById<Button>(R.id.open_settings)
	private val meta      = root.findViewById<TextView>(R.id.meta)

	private var lookup     : Lookup? = null   // the stored lookup on screen, once it's finished
	private var pending    : Query? = null    // the selection we were opened with
	private var pinnedName : String? = null
	private var busy       = false
	private var pendingTurn: TextView? = null
	private var channelShown = ""

	init {
		engine.listener = this

		// A single-line input type keeps the Go key, and this lets it wrap.
		query.setHorizontallyScrolling(false)
		follow.setHorizontallyScrolling(false)

		run.setOnClickListener { runQuery() }
		ask.setOnClickListener { askFollowUp() }

		query.setOnEditorActionListener { _, action, event -> enterPressed(action, event, EditorInfo.IME_ACTION_GO) { runQuery() } }
		follow.setOnEditorActionListener { _, action, event -> enterPressed(action, event, EditorInfo.IME_ACTION_SEND) { askFollowUp() } }

		channel.setOnEditorActionListener { _, action, event ->
			enterPressed(action, event, EditorInfo.IME_ACTION_DONE) { channel.clearFocus() }
		}

		channel.setOnFocusChangeListener { _, focused ->
			if (!focused) commitChannel()
		}

		channel.setOnItemClickListener { _, _, _, _ -> channel.clearFocus() }

		pin.setOnClickListener {
			when {
				pinnedName != null -> engine.pin(null)
				channel.text.isNotBlank() -> engine.pin(channel.text.toString().trim())
				else -> {
					channel.requestFocus()
					showStatus("Type a channel name to pin.")
				}
			}
		}

		copy.setOnClickListener {
			val shown = lookup ?: return@setOnClickListener
			val text  = (listOf(shown.explanation) + shown.thread.map { "Q: ${it.q}\n${it.a}" }).joinToString("\n\n")
			val clip  = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

			clip.setPrimaryClip(ClipData.newPlainText("Read Deeper", text))
			copy.setText(R.string.copied)
			copy.postDelayed({ copy.setText(R.string.copy) }, 1500)
		}

		settings.setOnClickListener {
			activity.startActivity(Intent(activity, SettingsActivity::class.java))
		}

		engine.refreshState()
	}

	private fun enterPressed(action: Int, event: KeyEvent?, expected: Int, block: () -> Unit): Boolean {
		val isEnter = event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN

		if (action == expected || isEnter) {
			block()
			return true
		}

		return false
	}

	/* Start a lookup for a selection handed over by another app. */
	fun lookUp(selection: Query) {
		setBusy(false)
		pending = selection
		lookup  = null
		query.setText(selection.text)

		if (selection.text.isNotBlank()) runQuery() else query.requestFocus()
	}

	fun show(stored: Lookup, channelName: String) {
		pending = null
		showLookup(stored, channelName)
	}

	fun refresh() = engine.refreshState()

	fun detach() {
		// The request carries on (and saves) without a screen to draw on.
		engine.listener = null
	}

	private fun runQuery() {
		val text = query.text.toString().trim()

		if (text.isEmpty() || busy) return

		val shown = lookup

		if (shown != null && (text.equals(shown.text, ignoreCase = true) || Core.isRefinement(shown.text, text))) {
			engine.lookUp(Query(text, shown.context, shown.sourceUrl, shown.sourceTitle), replaceLookupId = shown.id)
			return
		}

		val origin        = pending
		val fromSelection = origin != null && (text == origin.text || Core.isRefinement(origin.text, text))

		lookup = null
		engine.lookUp(if (fromSelection) origin!!.copy(text = text) else Query(text))
	}

	private fun askFollowUp() {
		val question = follow.text.toString().trim()
		val shown    = lookup ?: return

		if (question.isEmpty() || busy) return

		engine.followUp(shown.id, question)
	}

	private fun commitChannel() {
		val value = channel.text.toString().trim()

		if (value == channelShown) return

		channelShown = value
		engine.setChannel(lookup?.id, value)
	}

	private fun setChannelText(name: String) {
		if (channel.hasFocus()) return

		channelShown = name
		channel.setText(name)
		channel.dismissDropDown()
	}

	private fun setBusy(value: Boolean) {
		busy = value
		run.isEnabled = !value
		ask.isEnabled = !value
	}

	private fun showStatus(text: String, isError: Boolean = false) {
		status.text = text
		status.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
		status.setTextColor(if (isError) ContextCompat.getColor(activity, R.color.error) else answer.currentTextColor)
	}

	private fun render(markdown: String): Spanned =
		Html.fromHtml(Core.toAndroidHtml(Core.markdownToHtml(markdown)), Html.FROM_HTML_MODE_COMPACT)

	private fun showLookup(stored: Lookup, channelName: String) {
		lookup = stored

		query.setText(stored.text)
		setChannelText(channelName)
		answer.text = render(stored.explanation)
		thread.removeAllViews()
		stored.thread.forEach { addTurn(it.q).text = render(it.a) }

		followRow.visibility = View.VISIBLE
		copy.visibility      = View.VISIBLE
		meta.text            = stored.model
		showStatus("")
	}

	private fun addTurn(question: String): TextView {
		val context = activity
		val pad     = (10 * context.resources.displayMetrics.density).toInt()

		val box = LinearLayout(context).apply {
			orientation = LinearLayout.VERTICAL
			setPadding(pad, pad / 2, 0, pad / 2)
			background = ContextCompat.getDrawable(context, R.drawable.thread_bar)
		}

		val q = TextView(context).apply {
			text  = question
			alpha = 0.7f
			setTypeface(typeface, Typeface.BOLD)
		}

		val a = TextView(context).apply {
			textSize = 15f
			setTextIsSelectable(true)
			setLineSpacing(3 * context.resources.displayMetrics.density, 1f)
		}

		box.addView(q)
		box.addView(a)
		thread.addView(box, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = pad })

		return a
	}

	// ─── Engine callbacks ───────────────────────────────────────────────────

	override fun onState(pinned: String?, channels: List<String>) {
		pinnedName = pinned
		channel.setAdapter(ArrayAdapter(activity, android.R.layout.simple_dropdown_item_1line, channels))

		pin.setText(if (pinned != null) R.string.pinned else R.string.auto)
		pin.setTextColor(ContextCompat.getColor(activity, if (pinned != null) R.color.pin else R.color.accent))

		if (lookup == null && !busy) setChannelText(pinned ?: "")
	}

	override fun onStart(op: LookupEngine.Op, question: String?) {
		setBusy(true)
		showStatus(activity.getString(R.string.thinking))
		settings.visibility = View.GONE

		if (op == LookupEngine.Op.LOOKUP) {
			answer.text = ""
			thread.removeAllViews()
			followRow.visibility = View.GONE
			copy.visibility      = View.GONE
			meta.text            = ""
		} else {
			pendingTurn = addTurn(question ?: "")
		}
	}

	override fun onChannel(name: String) = setChannelText(name)

	override fun onDelta(op: LookupEngine.Op, markdown: String) {
		showStatus("")

		if (op == LookupEngine.Op.LOOKUP) answer.text = render(markdown) else pendingTurn?.text = render(markdown)
	}

	override fun onLookupDone(lookup: Lookup, channelName: String) {
		setBusy(false)
		showLookup(lookup, channelName)
		onDone(lookup)
	}

	override fun onFollowUpDone(turn: Turn) {
		setBusy(false)
		showStatus("")
		pendingTurn?.text = render(turn.a)
		pendingTurn = null
		lookup?.thread?.add(turn)
		follow.setText("")
	}

	override fun onNotice(message: String) = showStatus(message, isError = true)

	override fun onError(op: LookupEngine.Op, message: String, needsKey: Boolean) {
		setBusy(false)
		showStatus(message, isError = true)
		settings.visibility = if (needsKey) View.VISIBLE else View.GONE

		if (op == LookupEngine.Op.FOLLOWUP) {
			(pendingTurn?.parent as? View)?.let { thread.removeView(it) }
			pendingTurn = null
		}
	}
}
