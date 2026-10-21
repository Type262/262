#!/bin/sh
# Static build for Render. Every deploy gets its own asset folder (v/<commit>), so a browser or CDN
# can never mix files from two deploys. Unversioned copies stay for external links (og:image).
set -e
V=$(printf %s "${RENDER_GIT_COMMIT:-dev}" | cut -c1-7)
rm -rf dist
mkdir -p "dist/v/$V"
cp -r assets lib "dist/v/$V/"
cp -r assets dist/
# stable download URLs used by the docs: /lib/wallet262.js and /bin/type262.mjs
cp -r lib dist/
mkdir -p dist/bin && cp bin/type262.mjs dist/bin/
for f in index.html app.html docs.html; do
  sed -e "s#\"assets/#\"v/$V/assets/#g" -e "s#\"lib/#\"v/$V/lib/#g" "$f" > "dist/$f"
done
echo "built version $V"
