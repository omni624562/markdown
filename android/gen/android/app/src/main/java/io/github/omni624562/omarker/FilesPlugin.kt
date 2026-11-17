package io.github.omni624562.omarker

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class CreateArgs {
  var name: String = ""
  var mime: String = "text/markdown"
}

@InvokeArg
class UriArgs {
  lateinit var uri: String
}

@InvokeArg
class WriteArgs {
  lateinit var uri: String
  /** 檔案內容（Base64）。 */
  lateinit var data: String
}

/**
 * 用系統的檔案選擇器開啟、建立檔案，並照選到的位置讀寫。
 *
 * Tauri 內建的檔案對話框在 Android 上用 ACTION_GET_CONTENT：只能讀，存不回原檔，也拿不到檔名。
 * 這裡用 ACTION_OPEN_DOCUMENT／ACTION_CREATE_DOCUMENT，拿到可以讀寫的位置（雲端硬碟、SD 卡也可以），
 * 並請系統記住這個權限，之後存檔直接寫回去。
 */
@TauriPlugin
class FilesPlugin(private val activity: Activity) : Plugin(activity) {
  /** 開一個檔案選擇器。回傳 `{ uri, name }`；使用者取消時 `uri` 是 null。 */
  @Command
  fun pickFile(invoke: Invoke) {
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
      intent.addCategory(Intent.CATEGORY_OPENABLE)
      intent.type = "*/*"
      intent.addFlags(RW_FLAGS or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      startActivityForResult(invoke, intent, "pickResult")
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "無法開啟檔案選擇器")
    }
  }

  /** 另存新檔：讓使用者選位置與檔名。回傳 `{ uri, name }`；取消時 `uri` 是 null。 */
  @Command
  fun createFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(CreateArgs::class.java)
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
      intent.addCategory(Intent.CATEGORY_OPENABLE)
      intent.type = args.mime.ifEmpty { "application/octet-stream" }
      intent.putExtra(Intent.EXTRA_TITLE, args.name)
      intent.addFlags(RW_FLAGS or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      startActivityForResult(invoke, intent, "pickResult")
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "無法開啟存檔對話框")
    }
  }

  @ActivityCallback
  fun pickResult(invoke: Invoke, result: ActivityResult) {
    val out = JSObject()
    val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
    if (uri == null) {
      out.put("uri", null)
      invoke.resolve(out)
      return
    }
    // 請系統記住讀寫的權限（給了寫入就一起記；只給讀取的來源就只記讀取）。
    for (flags in intArrayOf(RW_FLAGS, Intent.FLAG_GRANT_READ_URI_PERMISSION)) {
      try {
        activity.contentResolver.takePersistableUriPermission(uri, flags)
        break
      } catch (_: Exception) {
      }
    }
    out.put("uri", uri.toString())
    out.put("name", displayName(uri))
    // 開檔時馬上把內容讀出來：有些來源（例如 OneDrive）只在選檔的當下給權限，不讓 App 記住，
    // 之後再讀會被拒絕。存檔對話框（新的空檔案）不必讀。
    if (invoke.getArgs().optBoolean("read", false)) {
      try {
        val bytes = activity.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        if (bytes != null) {
          out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
          out.put("modified", lastModified(uri))
        }
      } catch (ex: Exception) {
        out.put("error", ex.message ?: "無法讀取檔案")
      }
    }
    invoke.resolve(out)
  }

  /** 讀出檔案：`{ data（Base64）, name, modified（毫秒，不知道時是 0） }`。 */
  @Command
  fun readFile(invoke: Invoke) {
    try {
      val uri = Uri.parse(invoke.parseArgs(UriArgs::class.java).uri)
      val bytes = activity.contentResolver.openInputStream(uri)?.use { it.readBytes() }
      if (bytes == null) {
        invoke.reject("無法讀取檔案")
        return
      }
      val out = JSObject()
      out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
      out.put("name", displayName(uri))
      out.put("modified", lastModified(uri))
      invoke.resolve(out)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "無法讀取檔案")
    }
  }

  /** 寫入檔案（整個換掉）。回傳 `{ modified }`。 */
  @Command
  fun writeFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(WriteArgs::class.java)
      val uri = Uri.parse(args.uri)
      val bytes = Base64.decode(args.data, Base64.DEFAULT)
      // "wt"：寫入並截斷（新內容比較短時不會留下舊內容的尾巴）。
      val stream = activity.contentResolver.openOutputStream(uri, "wt")
      if (stream == null) {
        invoke.reject("無法寫入檔案")
        return
      }
      stream.use { it.write(bytes) }
      val out = JSObject()
      out.put("modified", lastModified(uri))
      invoke.resolve(out)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "無法寫入檔案")
    }
  }

  private fun displayName(uri: Uri): String {
    try {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst() && !c.isNull(0)) return c.getString(0)
      }
    } catch (_: Exception) {
    }
    return uri.lastPathSegment?.substringAfterLast('/') ?: ""
  }

  private fun lastModified(uri: Uri): Long {
    try {
      activity.contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_LAST_MODIFIED), null, null, null)?.use { c ->
        if (c.moveToFirst() && !c.isNull(0)) return c.getLong(0)
      }
    } catch (_: Exception) {
    }
    return 0
  }

  companion object {
    private const val RW_FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
  }
}
