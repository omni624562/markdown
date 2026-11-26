bump: patch

- 修正：即時預覽時滑鼠移到某些位置，一直跳出「發生錯誤：Cannot read properties of null (reading 'length')」。編輯器元件找不到滑鼠下面那一行時，改用那一行的開頭（右鍵、拖放圖片時游標仍會移到滑鼠指的那一行），並把細節記進錯誤紀錄，不再跳通知。
