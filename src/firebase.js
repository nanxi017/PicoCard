// - 核心理由：系統後端連線中樞，負責初始化 Firebase App、授權機制，並啟用本地 Firestore 離線持久資料同步。
// - 權責邊界：[負責] 模組連線初始化、離線快取快取管理器（LocalCache）配置。 [不負責] 登入狀態監聽、卡片增刪與資料集訂閱。
// - MWE：修改設定檔中的 placeholder 連線字串後，可直接於瀏覽器載入使用。
// - 致命錯誤邊界：若不啟用 persistentMultipleTabManager()，使用者在手機端多開瀏覽器分頁時會因 IndexedDB 獨佔鎖定而報錯當機；此配置已徹底解決此風險，風險受控。

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// =========================================================================
// 注意：請將此處的 Placeholder 配置取代為您在 Firebase Console 取得的正式專案配置。
// =========================================================================
const firebaseConfig = {
    apiKey: "AIzaSyC4F7PcgYnKlMkrWbw60FhE8yPcILhaPW8",
    authDomain: "picocard-655e5.firebaseapp.com",
    projectId: "picocard-655e5",
    storageBucket: "picocard-655e5.firebasestorage.app",
    messagingSenderId: "504319949193",
    appId: "1:504319949193:web:648aae66fbb0f1c0504958"
};

// 初始化 App 實體
const app = initializeApp(firebaseConfig);

// 建立 Auth 與 Google Provider 實體
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// 初始化 Firestore，並強制啟用 IndexedDB 離線持久快取及多分頁標籤同步管理器 (支援 PWA 離線操作)
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

export { app, auth, db, googleProvider };
