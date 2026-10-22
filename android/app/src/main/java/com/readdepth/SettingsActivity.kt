package com.readdepth

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.util.Locale
import kotlin.concurrent.thread

class SettingsActivity : AppCompatActivity() {

	private lateinit var apiKey       : EditText
	private lateinit var model        : AutoCompleteTextView
	private lateinit var modelStatus  : TextView
	private lateinit var keyStatus    : TextView
	private lateinit var targetWords  : EditText
	private lateinit var reasoning    : Spinner
	private lateinit var rosterSize   : EditText
	private lateinit var historyLimit : EditText
	private lateinit var systemPrompt : EditText

	private lateinit var exportFolder : TextView

	private var models: List<OpenRouter.Model> = emptyList()

	private val pickFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
		if (uri != null) setFolder(uri)
	}
	private lateinit var defaultPrompt: String

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContentView(R.layout.activity_settings)
		title = getString(R.string.settings)
		supportActionBar?.setDisplayHomeAsUpEnabled(true)

		apiKey       = findViewById(R.id.api_key)
		model        = findViewById(R.id.model)
		modelStatus  = findViewById(R.id.model_status)
		keyStatus    = findViewById(R.id.key_status)
		targetWords  = findViewById(R.id.target_words)
		reasoning    = findViewById(R.id.reasoning)
		rosterSize   = findViewById(R.id.roster_size)
		historyLimit = findViewById(R.id.history_limit)
		systemPrompt = findViewById(R.id.system_prompt)
		exportFolder = findViewById(R.id.export_folder)

		defaultPrompt = Prefs.defaultSystemPrompt(this)

		val versionName = packageManager.getPackageInfo(packageName, 0).versionName
		findViewById<TextView>(R.id.version).text = "Read Deeper $versionName"

		reasoning.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, REASONING_EFFORTS)

		val settings = Prefs.load(this)

		apiKey.setText(settings.apiKey)
		model.setText(settings.model)
		targetWords.setText(settings.targetWords.toString())
		reasoning.setSelection(REASONING_EFFORTS.indexOf(settings.reasoningEffort).coerceAtLeast(0))
		rosterSize.setText(settings.rosterSize.toString())
		historyLimit.setText(settings.historyLimit.toString())
		systemPrompt.setText(settings.systemPrompt.ifBlank { defaultPrompt })

		findViewById<Button>(R.id.toggle_key).setOnClickListener { button ->
			val hidden = apiKey.inputType and InputType.TYPE_TEXT_VARIATION_PASSWORD != 0

			apiKey.inputType = InputType.TYPE_CLASS_TEXT or
				if (hidden) InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD else InputType.TYPE_TEXT_VARIATION_PASSWORD
			apiKey.setSelection(apiKey.text.length)
			(button as Button).text = if (hidden) "Hide" else "Show"
		}

		findViewById<Button>(R.id.test_key).setOnClickListener { testKey() }
		findViewById<Button>(R.id.refresh_models).setOnClickListener { loadModels(force = true) }
		findViewById<Button>(R.id.reset_prompt).setOnClickListener { systemPrompt.setText(defaultPrompt) }

		findViewById<Button>(R.id.choose_folder).setOnClickListener { pickFolder.launch(null) }
		findViewById<Button>(R.id.export_off).setOnClickListener { setFolder(null) }
		findViewById<Button>(R.id.export_all).setOnClickListener { exportAll() }
		showFolder()

		model.setOnItemClickListener { _, _, _, _ -> describeModel() }
		model.setOnFocusChangeListener { _, focused -> if (!focused) describeModel() }

		loadModels(force = false)
	}

	override fun onSupportNavigateUp(): Boolean {
		finish()
		return true
	}

	override fun onPause() {
		super.onPause()
		save()
	}

	private fun save() {
		val defaults = Settings()
		val prompt   = systemPrompt.text.toString()

		Prefs.save(this, Settings(
			apiKey          = apiKey.text.toString().trim(),
			model           = model.text.toString().trim().ifEmpty { defaults.model },
			targetWords     = Core.clamp(targetWords.text.toString().toIntOrNull() ?: defaults.targetWords, 20, 300),
			reasoningEffort = reasoning.selectedItem as String,
			// Saved as "" while it matches the default, so a future improvement
			// to the default reaches you unless you've written your own.
			systemPrompt    = if (prompt.trim() == defaultPrompt.trim()) "" else prompt,
			rosterSize      = Core.clamp(rosterSize.text.toString().toIntOrNull() ?: defaults.rosterSize, 1, 50),
			historyLimit    = Core.clamp(historyLimit.text.toString().toIntOrNull() ?: defaults.historyLimit, 50, 5000)
		))
	}

	private fun setFolder(uri: Uri?) {
		val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

		// Give back access to the old folder; keep access to the new one across restarts.
		Prefs.exportFolder(this)?.let {
			try {
				contentResolver.releasePersistableUriPermission(Uri.parse(it), flags)
			} catch (e: SecurityException) {
				// Already gone.
			}
		}

		if (uri != null) contentResolver.takePersistableUriPermission(uri, flags)

		Prefs.setExportFolder(this, uri?.toString())
		showFolder()
	}

	private fun showFolder() {
		thread {
			val name = Exporter.folderName(this)
			val on   = Prefs.exportFolder(this) != null

			runOnUiThread {
				when {
					!on -> setStatus(exportFolder, "Off")
					name == null -> setStatus(exportFolder, "The folder isn't available any more. Choose it again.", isError = true)
					else -> setStatus(exportFolder, "Saving to: $name")
				}
			}
		}
	}

	private fun exportAll() {
		if (Prefs.exportFolder(this) == null) {
			setStatus(exportFolder, "Choose a folder first.", isError = true)
			return
		}

		setStatus(exportFolder, "Exporting…")

		thread {
			try {
				val count = Exporter.exportAll(this)
				val name  = Exporter.folderName(this)

				runOnUiThread { setStatus(exportFolder, "Saved $count note${if (count == 1) "" else "s"} to $name.") }
			} catch (e: Exception) {
				runOnUiThread { setStatus(exportFolder, "Export failed: ${e.message}", isError = true) }
			}
		}
	}

	private fun setStatus(view: TextView, text: String, isError: Boolean = false) {
		view.text = text
		view.setTextColor(ContextCompat.getColor(this, if (isError) R.color.error else R.color.accent))
	}

	private fun testKey() {
		val key = apiKey.text.toString().trim()

		if (key.isEmpty()) {
			setStatus(keyStatus, "Enter a key first.", isError = true)
			return
		}

		save()
		setStatus(keyStatus, "Checking…")

		thread {
			try {
				val info  = OpenRouter.checkKey(key)
				val used  = info.usage?.let { String.format(Locale.US, ", $%.2f used", it) } ?: ""
				val left  = info.limitRemaining?.let { String.format(Locale.US, ", $%.2f left", it) } ?: ", no spending limit"

				runOnUiThread { setStatus(keyStatus, "Key OK$used$left.") }
			} catch (e: ApiException) {
				runOnUiThread { setStatus(keyStatus, e.message ?: "Failed.", isError = true) }
			}
		}
	}

	private fun loadModels(force: Boolean) {
		modelStatus.text = "Loading models…"

		thread {
			try {
				val list = OpenRouter.listModels(this, force)

				runOnUiThread {
					models = list
					model.setAdapter(ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, list.map { it.id }))
					describeModel()
				}
			} catch (e: Exception) {
				runOnUiThread {
					setStatus(modelStatus, "Couldn't load the model list (${e.message}). You can still type a model ID.", isError = true)
				}
			}
		}
	}

	private fun describeModel() {
		if (models.isEmpty()) return

		val id    = model.text.toString().trim()
		val found = models.find { it.id == id }

		if (found != null) {
			setStatus(modelStatus, "${found.name}: ${found.priceLabel()}.")
		} else {
			setStatus(modelStatus, "\"$id\" isn't in OpenRouter's model list. Check the ID.", isError = true)
		}
	}
}
