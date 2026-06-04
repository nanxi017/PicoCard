// - 核心理由：實現離線啟動，劫持靜態資源 GET 請求以提供離線快取，並排除 Firebase 動態 API。
// - 權責邊界：[負責] 快取清單內的 HTML/CSS/JS/SVG 資源。 [不負責] 劫持 Firestore Web Socket、Auth API 或是 POST 請求。
// - MWE：在客戶端由 navigator.serviceWorker.register('./sw.js') 註冊。
// - 致命錯誤邊界：若不慎快取 Firebase Auth 或是 Firestore API 會造成動態資料死鎖；已在 fetch 階段嚴格限制「僅處理同源 GET 請求」，風險受控。

const CACHE_NAME = 'yiqiban-v4-single-shell';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icon.svg',
  './src/firebase.js',
  './src/auth.js',
  './src/firestore.js',
  './src/state.js',
  './src/ui.js',
  './src/app.js'
];

// 安裝階段：開闢快取，載入所有關鍵靜態資源
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// 激活階段：清理舊版本快取，並立即接管所有客戶端
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 攔截請求階段：同源靜態資源採用 Network-First 策略，其餘動態 API 直接放行
self.addEventListener('fetch', (e) => {
  // 只攔截 GET 請求
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // 僅限同源靜態資源進行快取
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          // 網路連線成功，複製一份結果存入快取，並回傳原始結果
          if (res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return res;
        })
        .catch(() => {
          // 網路斷線，退回到快取資源
          return caches.match(e.request).then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            // 如果連 HTML 都找不到（例如深層路由），退回到 index.html 入口
            if (e.request.mode === 'navigate') {
              return caches.match('./index.html');
            }
          });
        })
    );
  }
});
