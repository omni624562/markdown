package io.github.omni624562.omarker

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 新版 Android 的畫面會畫到狀態列、導覽列、鏡頭開孔的下面（edge-to-edge），螢幕鍵盤也是蓋在畫面上。
    // 把這些區域留成邊距：網頁的內容不會被系統列蓋住，鍵盤跳出來時編輯區跟著縮小、游標不會被擋住。
    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
