// 從 Firebase 主控台 → 專案設定（齒輪圖示）→ Cloud Messaging 分頁 →
// 「Web Push 憑證」區塊按「產生金鑰組」取得。這是公開金鑰（用來識別這個網站給瀏覽器看），
// 不是密碼或私密金鑰，可以安心放在這種前端程式碼裡、提交進 git。
export const VAPID_KEY = "PASTE_VAPID_KEY_HERE";
