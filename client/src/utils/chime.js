// ============================================
// client/src/utils/chime.js — tiny synthesized acknowledgment tone
// No audio file/asset needed — a couple of short Web Audio oscillator
// beeps, so wake-word detection has near-zero latency feedback.
// ============================================

let sharedCtx = null;
function getCtx() {
    if (!sharedCtx) sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
    return sharedCtx;
}

function beep(ctx, freq, startTime, duration, gainValue = 0.15) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(gainValue, startTime + 0.01);
    gain.gain.linearRampToValueAtTime(0, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
}

// Played the instant the wake word is heard — a quick rising two-tone "yes?"
// so you know it's your turn to speak, without waiting on a full TTS round trip.
export function playWakeAcknowledgeChime() {
    const ctx = getCtx();
    const now = ctx.currentTime;
    beep(ctx, 660, now, 0.08);
    beep(ctx, 880, now + 0.09, 0.1);
}