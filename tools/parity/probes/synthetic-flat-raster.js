/**
 * Regression: run the full coverage kernel over a synthetic FLAT 50 m DEM at
 * the Newcastle test site (128x128 cells, 25 km half-size) and compare against
 * the CPU oracle expectation (recorded in synthetic-flat-expected.json).
 * Flat terrain isolates the kernel's geometry/link-budget math from DEM data.
 *
 * Run via:  python3 run-page-probe.py --probe probes/synthetic-flat-raster.js --wgsl <shader.wgsl>
 */
(async () => {
  const WGSL = __WGSL__;
  const ad = await navigator.gpu.requestAdapter();
  const dev = await ad.requestDevice();
  const module = dev.createShaderModule({ code: WGSL });
  const pipeline = dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const WORLD = 1048576.0;
  const toPx = (lon, lat) => {
    const x = (lon + 180) / 360 * WORLD;
    const lr = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * WORLD;
    return { x, y };
  };
  const site = { lon: -1.6237, lat: 54.9648 };
  const sp = toPx(site.lon, site.lat);
  const halfPx = 1139, OUT = 128, cellPx = (2 * halfPx) / OUT;
  const demOriginX = Math.floor((sp.x - halfPx - 64) / 256) * 256;
  const demOriginY = Math.floor((sp.y - halfPx - 64) / 256) * 256;
  const demW = 2816, demH = 2816;
  const dem = new Float32Array(demW * demH); dem.fill(50);
  const total = OUT * OUT;
  const demBuf = dev.createBuffer({ size: dem.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(demBuf, 0, dem);
  const mB = dev.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const cB = dev.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const pB = dev.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const p = new Float32Array(28);
  p[0] = site.lon; p[1] = site.lat; p[2] = 52; p[3] = 2;
  p[4] = demOriginX; p[5] = demOriginY; p[6] = demW; p[7] = demH;
  p[8] = sp.x - halfPx; p[9] = sp.y - halfPx; p[10] = cellPx; p[11] = OUT; p[12] = OUT;
  p[13] = 22; p[14] = 3; p[15] = 0; p[16] = -124; p[17] = 15; p[18] = 5; p[19] = 100; p[20] = 868;
  p[21] = 90; p[22] = 24; p[23] = 512; p[24] = 0; p[25] = Number.NaN; p[26] = OUT;
  dev.queue.writeBuffer(pB, 0, p);
  const bg = dev.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: pB } }, { binding: 1, resource: { buffer: demBuf } },
    { binding: 2, resource: { buffer: mB } }, { binding: 3, resource: { buffer: cB } } ] });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(OUT / 8, OUT / 8, 1); pass.end();
  const sM = dev.createBuffer({ size: total * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const sC = dev.createBuffer({ size: total * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  enc.copyBufferToBuffer(mB, 0, sM, 0, total * 4);
  enc.copyBufferToBuffer(cB, 0, sC, 0, total * 4);
  dev.queue.submit([enc.finish()]);
  await sM.mapAsync(GPUMapMode.READ); await sC.mapAsync(GPUMapMode.READ);
  const margins = new Float32Array(sM.getMappedRange().slice(0));
  const codes = new Uint32Array(sC.getMappedRange().slice(0));
  const counts = [0, 0, 0, 0, 0, 0];
  for (const c of codes) counts[c] = (counts[c] || 0) + 1;
  return JSON.stringify({ counts, mCentre: Math.round(margins[64 * OUT + 64] * 10) / 10, mCorner: Math.round(margins[0] * 10) / 10 });
})()
