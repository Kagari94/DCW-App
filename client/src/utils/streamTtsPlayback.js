export async function playStreamedTts(url, body) {
  const res = await fetch(url, { method: 'POST', body });
  const sampleRate = Number(res.headers.get('X-Sample-Rate'));
  const channels = Number(res.headers.get('X-Channels'));

  const ctx = new AudioContext({ sampleRate });
  let nextStartTime = ctx.currentTime;
  let leftover = new Uint8Array(0); // odd trailing byte across chunk boundaries

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const bytes = concatBytes(leftover, value);
    const usableLen = bytes.length - (bytes.length % 2);
    leftover = bytes.subarray(usableLen);

    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, usableLen / 2);
    const float32 = Float32Array.from(int16, (s) => s / 32768);

    const audioBuffer = ctx.createBuffer(channels, float32.length / channels, sampleRate);
    audioBuffer.copyToChannel(float32, 0);

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ctx.destination);

    const startAt = Math.max(nextStartTime, ctx.currentTime);
    src.start(startAt);
    nextStartTime = startAt + audioBuffer.duration;
  }
}