// =============================================================
//  Service Worker  ―  オフライン対応 / 静的アセットのキャッシュ
//
//  バージョンを更新したら CACHE_VERSION を上げる。古いキャッシュは
//  activate イベントで掃除される。
// =============================================================
const CACHE_VERSION = 'simant-ipad-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-76.png',
  './icon-120.png',
  './icon-152.png',
  './icon-167.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  // GitHub Pages の都合で `src/` 配下にしたい場合と
  // ファイル直下に置いた場合の両方をカバー
  './bus.js',
  './cartridge.js',
  './cpu65816.js',
  './disasm.js',
  './emulator.js',
  './ppu.js',
  './spc700.js',
  './src/bus.js',
  './src/cartridge.js',
  './src/cpu65816.js',
  './src/disasm.js',
  './src/emulator.js',
  './src/ppu.js',
  './src/spc700.js',
];

// インストール時: 主要アセットを一括キャッシュ。失敗しても続行する。
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // 個別に失敗しても全体を止めない (片側のパスしか存在しないため)
      Promise.all(ASSETS.map((url) => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

// 有効化時: 古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// fetch 戦略
//   - GET 以外は素通し
//   - HTML はネット優先 (新しい版があれば取りに行く、失敗時はキャッシュ)
//   - 他 (JS / 画像 / json) はキャッシュ優先 (高速 + オフライン対応)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // ネット優先 (オフライン時 / 失敗時はキャッシュ)
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match('./index.html')))
    );
  } else {
    // キャッシュ優先 (無ければネット → キャッシュへ保存)
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached);
      })
    );
  }
});

// クライアントから "SKIP_WAITING" メッセージで即時更新
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
