/**
 * Precision check for the shader's built-in transcendentals (sinF/cosF/atanF/
 * atan2F from shader.wgsl). Sweeps sin/cos over [-5.12, 5.10] and atan/atan2
 * over matching ranges, comparing against the browser's f64 Math functions.
 * PASS criteria: max abs error < 1e-5 (expected ~2e-7 — f32 ulp scale).
 *
 * Run via:  python3 run-page-probe.py --probe probes/trig-accuracy.js --wgsl <shader.wgsl>
 */
const TRIG_TEST_ENTRY = `

@compute @workgroup_size(64, 1, 1)
fn trigTest(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= 1024u) { return; }
  let keepDem = dem[0u];
  let keepParams = params.cellPx;
  if (i < 512u) {
    let x = (f32(i) - 256.0) * 0.02;
    let sc = sinCosF(x);
    outMargins[i] = sc.x;
    outMargins[512u + i] = sc.y;
  } else {
    let a = (f32(i) - 768.0) * 0.02;
    let sc = sinCosF(a);
    outMargins[512u + i] = atan2F(sc.x, sc.y);
    outMargins[1536u + (i - 512u)] = atanF((f32(i) - 768.0) * 0.05);
  }
  outCodes[0] = u32(keepDem + keepParams) + 1u;
}
`;

(async () => {
  const WGSL = __WGSL__ + TRIG_TEST_ENTRY;
  const ad = await navigator.gpu.requestAdapter();
  const dev = await ad.requestDevice();
  const module = dev.createShaderModule({ code: WGSL });
  const ci = await module.getCompilationInfo();
  const cerr = ci.messages.filter((m) => m.type === 'error').map((m) => m.message.slice(0, 160));
  if (cerr.length) return JSON.stringify({ compileErrors: cerr });
  const pipeline = dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'trigTest' } });
  const data = new Float32Array(256 * 256); data.fill(50);
  const demBuf = dev.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(demBuf, 0, data);
  const mB = dev.createBuffer({ size: 2048 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const cB = dev.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const pB = dev.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const p = new Float32Array(28); p[10] = 17.79; // keep params binding live
  dev.queue.writeBuffer(pB, 0, p);
  const bg = dev.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: pB } }, { binding: 1, resource: { buffer: demBuf } },
    { binding: 2, resource: { buffer: mB } }, { binding: 3, resource: { buffer: cB } } ] });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(16, 1, 1); pass.end();
  const sM = dev.createBuffer({ size: 2048 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const sC = dev.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  enc.copyBufferToBuffer(mB, 0, sM, 0, 2048 * 4);
  enc.copyBufferToBuffer(cB, 0, sC, 0, 4);
  dev.queue.submit([enc.finish()]);
  await sM.mapAsync(GPUMapMode.READ); await sC.mapAsync(GPUMapMode.READ);
  const arr = new Float32Array(sM.getMappedRange().slice(0));
  let maxSinErr = 0, maxCosErr = 0, maxAtan2Err = 0, maxAtanErr = 0;
  for (let i = 0; i < 512; i++) {
    const x = (i - 256) * 0.02;
    maxSinErr = Math.max(maxSinErr, Math.abs(arr[i] - Math.sin(x)));
    maxCosErr = Math.max(maxCosErr, Math.abs(arr[512 + i] - Math.cos(x)));
  }
  for (let i = 512; i < 1024; i++) {
    const a = (i - 768) * 0.02;
    let e = Math.abs(arr[512 + i] - a);
    if (e > Math.PI) e = Math.abs(e - 2 * Math.PI);
    maxAtan2Err = Math.max(maxAtan2Err, e);
    const v = (i - 768) * 0.05;
    maxAtanErr = Math.max(maxAtanErr, Math.abs(arr[1536 + (i - 512)] - Math.atan(v)));
  }
  const pass2 = maxSinErr < 1e-5 && maxCosErr < 1e-5 && maxAtan2Err < 1e-5 && maxAtanErr < 1e-5;
  return JSON.stringify({ pass: pass2, maxSinErr, maxCosErr, maxAtan2Err, maxAtanErr });
})()
