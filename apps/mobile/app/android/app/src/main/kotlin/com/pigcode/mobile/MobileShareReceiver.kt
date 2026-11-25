package com.pigcode.mobile

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors

data class IncomingShareBatch(
    val batchId: String,
    val paths: List<String>,
    val truncatedCount: Int,
) {
    fun toWire(): Map<String, Any> = mapOf(
        "batchId" to batchId,
        "paths" to paths,
        "truncatedCount" to truncatedCount,
    )
}

class MobileShareReceiver(context: Context) {
    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor()

    private var channel: MethodChannel? = null
    private var pendingBatch: IncomingShareBatch? = null
    private var activeCopyCount = 0
    private val pendingConsumeResults = mutableListOf<MethodChannel.Result>()
    private var disposed = false

    fun attach(messenger: BinaryMessenger) {
        channel?.setMethodCallHandler(null)
        channel = MethodChannel(messenger, CHANNEL_NAME).also { bridge ->
            bridge.setMethodCallHandler { call, result ->
                when (call.method) {
                    "consumePendingBatch" -> handleConsumePendingBatch(result)
                    "cleanupBatch" -> {
                        val batchId = call.argument<String>("batchId")
                        if (batchId != null && BATCH_ID_PATTERN.matches(batchId)) {
                            if (pendingBatch?.batchId == batchId) {
                                pendingBatch = null
                            }
                            scheduleDeleteBatch(batchId)
                        }
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
        }
        ioExecutor.execute { cleanupStaleBatches() }
    }

    fun handleIntent(intent: Intent?) {
        if (disposed || intent == null) return
        val action = intent.action ?: return
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
        if (intent.getBooleanExtra(EXTRA_SHARE_CONSUMED, false)) return

        val uris = extractImageUris(intent)
        if (uris.isEmpty()) return

        intent.putExtra(EXTRA_SHARE_CONSUMED, true)
        val totalCount = uris.size
        val selected = uris.take(MAX_SHARED_IMAGES)
        val truncatedCount = maxOf(0, totalCount - MAX_SHARED_IMAGES)

        activeCopyCount++
        ioExecutor.execute {
            val batch = copyBatch(selected, truncatedCount)
            mainHandler.post { onCopyFinished(batch) }
        }
    }

    fun dispose() {
        disposed = true
        channel?.setMethodCallHandler(null)
        channel = null
        val waiters = pendingConsumeResults.toList()
        pendingConsumeResults.clear()
        for (waiter in waiters) {
            runCatching { waiter.success(null) }
        }
        ioExecutor.shutdown()
    }

    private fun handleConsumePendingBatch(result: MethodChannel.Result) {
        val current = pendingBatch
        if (current != null) {
            pendingBatch = null
            result.success(current.toWire())
            return
        }
        if (activeCopyCount > 0) {
            pendingConsumeResults.add(result)
            return
        }
        result.success(null)
    }

    private fun onCopyFinished(batch: IncomingShareBatch?) {
        activeCopyCount = maxOf(0, activeCopyCount - 1)
        if (disposed) {
            if (batch != null) {
                scheduleDeleteBatch(batch.batchId)
            }
            return
        }
        if (pendingConsumeResults.isNotEmpty()) {
            if (batch != null) {
                val waiters = pendingConsumeResults.toList()
                pendingConsumeResults.clear()
                waiters.firstOrNull()?.success(batch.toWire())
                for (extra in waiters.drop(1)) {
                    extra.success(null)
                }
                return
            }
            if (activeCopyCount == 0) {
                val waiters = pendingConsumeResults.toList()
                pendingConsumeResults.clear()
                val existing = pendingBatch
                pendingBatch = null
                waiters.firstOrNull()?.success(existing?.toWire())
                for (extra in waiters.drop(1)) {
                    extra.success(null)
                }
            }
            return
        }
        if (batch == null) return

        val previous = pendingBatch
        if (previous != null && previous.batchId != batch.batchId) {
            scheduleDeleteBatch(previous.batchId)
        }
        pendingBatch = batch

        channel?.invokeMethod(
            "onShareBatch",
            batch.toWire(),
            object : MethodChannel.Result {
                override fun success(result: Any?) {
                    if (pendingBatch?.batchId == batch.batchId) {
                        pendingBatch = null
                    }
                }

                override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) {
                    // Keep pendingBatch so Flutter can pull it via consumePendingBatch.
                }

                override fun notImplemented() {
                    // Dart handler not registered yet; keep pendingBatch for cold-start pull.
                }
            },
        )
    }

    private fun extractImageUris(intent: Intent): List<Uri> {
        val collected = LinkedHashSet<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> {
                val streamUri = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_STREAM)
                }
                if (streamUri != null) collected.add(streamUri)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val streams = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
                }
                if (streams != null) {
                    for (uri in streams) {
                        if (uri != null) collected.add(uri)
                    }
                }
            }
        }
        val clip = intent.clipData
        if (clip != null) {
            for (i in 0 until clip.itemCount) {
                val uri = clip.getItemAt(i)?.uri
                if (uri != null) collected.add(uri)
            }
        }
        return collected.filter { uri -> isLikelyImageUri(uri, intent.type) }
    }

    private fun isLikelyImageUri(uri: Uri, intentType: String?): Boolean {
        val resolvedType = runCatching { appContext.contentResolver.getType(uri) }.getOrNull()
        if (resolvedType != null) {
            return resolvedType.startsWith("image/", ignoreCase = true) ||
                resolvedType.equals("application/octet-stream", ignoreCase = true)
        }
        return intentType == null ||
            intentType.startsWith("image/", ignoreCase = true) ||
            intentType == "*/*"
    }

    private fun copyBatch(uris: List<Uri>, truncatedCount: Int): IncomingShareBatch? {
        val batchId = UUID.randomUUID().toString().lowercase(Locale.ROOT)
        val rootDir = File(appContext.cacheDir, SHARED_INCOMING_DIR)
        val batchDir = File(rootDir, batchId)
        if (!batchDir.mkdirs() && !batchDir.isDirectory) return null

        val paths = mutableListOf<String>()
        for ((index, uri) in uris.withIndex()) {
            val copied = copySingleUri(uri, batchDir, index)
            if (copied != null) {
                paths.add(copied.absolutePath)
            }
        }
        if (paths.isEmpty()) {
            batchDir.deleteRecursively()
            return null
        }
        return IncomingShareBatch(
            batchId = batchId,
            paths = paths,
            truncatedCount = truncatedCount,
        )
    }

    private fun copySingleUri(uri: Uri, batchDir: File, index: Int): File? {
        val mimeType = runCatching { appContext.contentResolver.getType(uri) }.getOrNull()
        val displayName = resolveDisplayName(uri)
        val safeName = sanitizeFileName(displayName, mimeType)
        val target = File(batchDir, "${index}_$safeName")

        val copiedOk = runCatching {
            appContext.contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(16 * 1024)
                    var total = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        total += read
                        if (total > MAX_SINGLE_FILE_BYTES) {
                            return@runCatching false
                        }
                        output.write(buffer, 0, read)
                    }
                    total > 0L
                }
            } ?: false
        }.getOrDefault(false)

        if (!copiedOk) {
            target.delete()
            return null
        }

        if (isHeifImage(target, mimeType)) {
            val transcoded = transcodeToJpeg(target, batchDir, index)
            if (transcoded != null) {
                target.delete()
                return transcoded
            }
        }
        return target
    }

    private fun resolveDisplayName(uri: Uri): String? {
        runCatching {
            appContext.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (column >= 0) {
                        val value = cursor.getString(column)
                        if (!value.isNullOrBlank()) return value
                    }
                }
            }
        }
        return uri.lastPathSegment
    }

    private fun sanitizeFileName(rawName: String?, mimeType: String?): String {
        val leaf = rawName
            ?.substringAfterLast('/')
            ?.substringAfterLast('\\')
            ?.trim()
            .orEmpty()
        val cleaned = leaf
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .trim('.')
            .take(80)
        val ext = extensionForMime(mimeType)
        if (cleaned.isEmpty()) return "image.$ext"
        return if (cleaned.contains('.')) cleaned else "$cleaned.$ext"
    }

    private fun extensionForMime(mimeType: String?): String = when (mimeType?.lowercase(Locale.ROOT)) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        "image/heic", "image/heif" -> "heic"
        else -> "jpg"
    }

    private fun isHeifImage(file: File, mimeType: String?): Boolean {
        if (mimeType.equals("image/heic", ignoreCase = true) ||
            mimeType.equals("image/heif", ignoreCase = true)) {
            return true
        }
        val header = ByteArray(12)
        val count = runCatching {
            FileInputStream(file).use { it.read(header) }
        }.getOrDefault(0)
        if (count < 12) return false
        if (header[4] != 'f'.code.toByte() ||
            header[5] != 't'.code.toByte() ||
            header[6] != 'y'.code.toByte() ||
            header[7] != 'p'.code.toByte()) {
            return false
        }
        val brand = String(header, 8, 4, Charsets.US_ASCII)
        return brand in setOf("heic", "heix", "hevc", "hevx", "mif1", "msf1")
    }

    private fun transcodeToJpeg(source: File, batchDir: File, index: Int): File? {
        return runCatching {
            val bitmap: Bitmap? = if (Build.VERSION.SDK_INT >= 28) {
                val imageSource = ImageDecoder.createSource(source)
                ImageDecoder.decodeBitmap(imageSource) { decoder, info, _ ->
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    val longest = maxOf(info.size.width, info.size.height)
                    if (longest > MAX_TRANSCODE_DIMENSION) {
                        val scale = MAX_TRANSCODE_DIMENSION.toFloat() / longest.toFloat()
                        decoder.setTargetSize(
                            maxOf(1, (info.size.width * scale).toInt()),
                            maxOf(1, (info.size.height * scale).toInt()),
                        )
                    }
                }
            } else {
                BitmapFactory.decodeFile(source.absolutePath)
            }
            if (bitmap == null) return@runCatching null
            val stem = source.nameWithoutExtension
                .removePrefix("${index}_")
                .ifBlank { "image" }
            val outFile = File(batchDir, "${index}_$stem.jpg")
            try {
                FileOutputStream(outFile).use { out ->
                    if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)) {
                        outFile.delete()
                        return@runCatching null
                    }
                }
            } finally {
                bitmap.recycle()
            }
            outFile
        }.getOrNull()
    }

    private fun scheduleDeleteBatch(batchId: String) {
        if (!BATCH_ID_PATTERN.matches(batchId)) return
        ioExecutor.execute {
            val dir = File(File(appContext.cacheDir, SHARED_INCOMING_DIR), batchId)
            runCatching { dir.deleteRecursively() }
        }
    }

    private fun cleanupStaleBatches() {
        val rootDir = File(appContext.cacheDir, SHARED_INCOMING_DIR)
        val children = rootDir.listFiles() ?: return
        val cutoff = System.currentTimeMillis() - STALE_BATCH_TTL_MS
        for (child in children) {
            if (child.lastModified() < cutoff) {
                runCatching { child.deleteRecursively() }
            }
        }
    }

    companion object {
        const val CHANNEL_NAME = "pigcode/share"
        private const val SHARED_INCOMING_DIR = "shared_incoming"
        private const val EXTRA_SHARE_CONSUMED = "com.pigcode.mobile.SHARE_CONSUMED"
        private const val MAX_SHARED_IMAGES = 6
        private const val MAX_SINGLE_FILE_BYTES = 30L * 1024L * 1024L
        private const val MAX_TRANSCODE_DIMENSION = 2048
        private const val STALE_BATCH_TTL_MS = 24L * 60L * 60L * 1000L
        private val BATCH_ID_PATTERN = Regex("^[A-Za-z0-9-]{1,128}$")
    }
}
