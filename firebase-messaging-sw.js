// Firebase Cloud Messaging 背景推播用的 Service Worker。
// 用傳統 importScripts 寫法而不是 ES module，因為部分瀏覽器（尤其 iOS Safari）
// 對 module 型 service worker 支援不完整。下面的設定值跟 firebase-config.js 重複，
// 是因為 service worker 檔案沒辦法 import 一般的 JS 模組——如果之後 Firebase
// 專案設定有變動，這裡要手動同步更新一次。
importScripts("https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCgERf59G6aqXyINK2iLU2OLwRLlrwydwQ",
  authDomain: "trading-journal-65a29.firebaseapp.com",
  projectId: "trading-journal-65a29",
  storageBucket: "trading-journal-65a29.firebasestorage.app",
  messagingSenderId: "683783822181",
  appId: "1:683783822181:web:2a9d6d7d099d1269fc1f8c",
});

const messaging = firebase.messaging();

// 只有「背景」(頁面沒開在前景) 收到的推播會走這裡；前景收到的在 app.js 的 onMessage 處理。
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || "觀察清單提醒", {
    body: body || "",
    icon: "./icon-192.png",
  });
});
