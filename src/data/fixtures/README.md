# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.
- `austin-cctv-placeholder.jpg` — upstream regression fixture: the Austin Mobility (City of Austin)
  traffic-camera "Image Unavailable" placeholder JPEG (12,805 bytes, SHA-256 `db8d3ffc…d963e08e`), captured 2026-09-18
  from `cctv.austinmobility.io/image/354.jpg`. Every offline Austin camera returns
  these exact bytes with HTTP 200. Used ONLY by `src/data/cctvProxy.test.mjs` to
  pin the server-side offline-camera placeholder detector offline (so a hash or
  detector change that would let this image through as a live frame fails a test);
  never served to the app.
