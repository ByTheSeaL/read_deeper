package com.readdepth

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class ApiException(message: String, val needsKey: Boolean = false) : Exception(message)

/*
 * The only code that talks to OpenRouter. Blocking calls: run them off the
 * main thread (LookupEngine does).
 */
object OpenRouter {

	private const val CONNECT_TIMEOUT_MS = 15_000
	private const val READ_TIMEOUT_MS    = 90_000

	class Call {
		@Volatile var cancelled = false
		@Volatile var connection: HttpURLConnection? = null

		fun cancel() {
			cancelled = true
			connection?.disconnect()
		}
	}

	/* Streams a chat completion, calling onDelta per chunk. Returns the finish reason. */
	fun streamChat(settings: Settings, messages: List<Message>, call: Call, onDelta: (String) -> Unit): String? {
		val body = JSONObject()
			.put("model", settings.model)
			.put("messages", JSONArray(messages.map { JSONObject().put("role", it.role).put("content", it.content) }))
			.put("stream", true)
			.put("max_tokens", Core.maxTokensFor(settings))
			.put("reasoning", if (settings.reasoningEffort == "off") {
				JSONObject().put("enabled", false)
			} else {
				// exclude: the reasoning still happens, it just isn't streamed back.
				JSONObject().put("effort", settings.reasoningEffort).put("exclude", true)
			})

		val connection = open("$OPENROUTER_BASE/chat/completions", settings.apiKey)

		call.connection = connection

		try {
			connection.requestMethod = "POST"
			connection.doOutput      = true
			connection.setRequestProperty("Content-Type", "application/json")
			connection.outputStream.use { it.write(body.toString().toByteArray()) }

			val status = connection.responseCode

			if (status !in 200..299) throw httpError(connection, status)

			val sse = SseReader()

			connection.inputStream.bufferedReader().use { reader ->
				val buffer = CharArray(2048)

				while (!sse.done && !call.cancelled) {
					val n = reader.read(buffer)

					if (n == -1) break

					val result = sse.push(String(buffer, 0, n))

					result.deltas.forEach(onDelta)

					if (result.error != null) throw ApiException(result.error)
				}
			}

			return sse.finishReason
		} catch (e: IOException) {
			if (call.cancelled) throw e
			throw ApiException("Couldn't reach OpenRouter. Are you offline?")
		} finally {
			connection.disconnect()
		}
	}

	data class KeyInfo(val usage: Double?, val limitRemaining: Double?)

	fun checkKey(apiKey: String): KeyInfo {
		val connection = open("$OPENROUTER_BASE/key", apiKey)

		try {
			val status = connection.responseCode

			if (status !in 200..299) throw httpError(connection, status)

			val data = JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).optJSONObject("data") ?: JSONObject()

			return KeyInfo(
				usage          = if (data.isNull("usage")) null else data.optDouble("usage"),
				limitRemaining = if (data.isNull("limit_remaining")) null else data.optDouble("limit_remaining")
			)
		} catch (e: IOException) {
			throw ApiException("Couldn't reach OpenRouter. Are you offline?")
		} finally {
			connection.disconnect()
		}
	}

	data class Model(val id: String, val name: String, val prompt: Double?, val completion: Double?) {
		fun priceLabel() = "${price(prompt)} in / ${price(completion)} out per million tokens"

		private fun price(n: Double?) = when {
			n == null -> "?"
			n == 0.0 -> "free"
			else -> "$" + (Math.round(n * 1000) / 1000.0).toString().removeSuffix(".0")
		}
	}

	private const val MODEL_CACHE_MS = 24L * 60 * 60 * 1000

	/* OpenRouter's public model list, cached for a day. */
	fun listModels(context: Context, force: Boolean = false): List<Model> {
		val cached = Prefs.cachedModels(context)

		val json = if (!force && cached != null && System.currentTimeMillis() - cached.first < MODEL_CACHE_MS) {
			cached.second
		} else {
			val connection = open("$OPENROUTER_BASE/models", null)

			try {
				val status = connection.responseCode

				if (status !in 200..299) throw httpError(connection, status)

				connection.inputStream.bufferedReader().use { it.readText() }.also { Prefs.cacheModels(context, it) }
			} catch (e: IOException) {
				throw ApiException("Couldn't reach OpenRouter. Are you offline?")
			} finally {
				connection.disconnect()
			}
		}

		val data = JSONObject(json).optJSONArray("data") ?: JSONArray()

		return (0 until data.length()).map { i ->
			val m       = data.getJSONObject(i)
			val pricing = m.optJSONObject("pricing")

			Model(
				id         = m.getString("id"),
				name       = m.optString("name").ifEmpty { m.getString("id") },
				prompt     = pricing?.optString("prompt")?.toDoubleOrNull()?.times(1e6),
				completion = pricing?.optString("completion")?.toDoubleOrNull()?.times(1e6)
			)
		}.sortedBy { it.id }
	}

	private fun open(url: String, apiKey: String?): HttpURLConnection {
		val connection = URL(url).openConnection() as HttpURLConnection

		connection.connectTimeout = CONNECT_TIMEOUT_MS
		connection.readTimeout    = READ_TIMEOUT_MS
		connection.setRequestProperty("HTTP-Referer", "https://github.com/ByTheSeaL/read_deeper")
		connection.setRequestProperty("X-Title", "Read Deeper")

		if (apiKey != null) connection.setRequestProperty("Authorization", "Bearer $apiKey")

		return connection
	}

	private fun httpError(connection: HttpURLConnection, status: Int): ApiException {
		val body = try {
			connection.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
		} catch (e: IOException) {
			""
		}

		val detail = try {
			JSONObject(body).getJSONObject("error").optString("message")
		} catch (e: Exception) {
			body.take(200)
		}

		return ApiException(Core.describeHttpError(status, detail), needsKey = status == 401)
	}
}
