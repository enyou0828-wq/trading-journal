#!/bin/sh
# git pre-commit hook：app.js、style.css 或 groups.js 有改動時，自動更新版本號，
# 讓瀏覽器一定成對拿到新版的 index.html + app.js/style.css/groups.js，不會新網頁配舊程式。
# groups.js 由 app.js 動態載入，所以它的版本號寫在 app.js 的 GROUPS_JS；改到它時連帶更新 app.js。
# 安裝：ln -sf ../../scripts/bump-asset-version.sh .git/hooks/pre-commit
V=$(date +%Y%m%d%H%M%S)
if git diff --cached --name-only | grep -qE '^groups\.js$'; then
  sed -i '' -E "s#'\./groups\.js\?v=[0-9]+'#'./groups.js?v=$V'#" app.js
  git add app.js
fi
if git diff --cached --name-only | grep -qE '^(app\.js|style\.css)$'; then
  sed -i '' -E "s#href=\"style.css(\?v=[0-9]+)?\"#href=\"style.css?v=$V\"#; s#src=\"app.js(\?v=[0-9]+)?\"#src=\"app.js?v=$V\"#" index.html
  git add index.html
fi
