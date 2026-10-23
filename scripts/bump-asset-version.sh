#!/bin/sh
# git pre-commit hook：app.js 或 style.css 有改動時，自動更新 index.html 裡的 ?v= 版本號，
# 讓瀏覽器一定成對拿到新版的 index.html + app.js/style.css，不會新網頁配舊程式。
# 安裝：ln -sf ../../scripts/bump-asset-version.sh .git/hooks/pre-commit
if git diff --cached --name-only | grep -qE '^(app\.js|style\.css)$'; then
  V=$(date +%Y%m%d%H%M%S)
  sed -i '' -E "s#href=\"style.css(\?v=[0-9]+)?\"#href=\"style.css?v=$V\"#; s#src=\"app.js(\?v=[0-9]+)?\"#src=\"app.js?v=$V\"#" index.html
  git add index.html
fi
