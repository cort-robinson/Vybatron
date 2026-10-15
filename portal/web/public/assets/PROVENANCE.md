# Approved ambient and fallback artwork

These are compressed derivatives of the original Vybatron generated raster
assets, retained in Git revision `0bb9bc6cda88488cbfc6013a11f109ed9a9ace37`.
The approved composition is unchanged. Production tracks use source artwork.

- Aurora source SHA256: `8aa6dd06d15df49f0fad25b3e4cecd29ac11fa47156f80f0efc3797c88939d8e`
- Cover source SHA256: `8d79eec200c5a2f65c96f29736d9d1cedc16c0811a4571c5437c351b654878c6`

Regenerate from the original PNG directory with
`node scripts/optimize-assets.mjs PATH_TO_SOURCE_PNGS` in `portal/web`.
Sharp 0.35.5 converts the background to WebP and makes responsive 320, 640 and
1024 pixel cover variants. All four total 309,686 bytes, replacing 4,054,126 bytes
of public PNGs. The static PWA cache contains derivatives only.
