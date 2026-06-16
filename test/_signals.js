// Synthetic audio signal generators for pitch-detection tests.

const DEFAULT_SAMPLE_RATE = 48000;

/**
 * Pure sine wave at `freq` Hz for `durationSec` seconds at `sampleRate`.
 * Amplitude is 0.5 to stay well under clipping.
 */
function sine(freq, sampleRate = DEFAULT_SAMPLE_RATE, durationSec = 0.1, amp = 0.5) {
    const n = Math.round(sampleRate * durationSec);
    const buf = new Float32Array(n);
    const omega = 2 * Math.PI * freq;
    for (let i = 0; i < n; i++) buf[i] = amp * Math.sin(omega * i / sampleRate);
    return buf;
}

/**
 * Sine wave with mixed-in harmonics. `components` is an array of
 * [freqMultiplier, amplitude] tuples — component freq is fundamental * multiplier.
 *
 * Example for bass-string-like signal where 2nd harmonic is stronger than fundamental:
 *     harmonicMix(41.2, [[1, 0.3], [2, 1.0], [3, 0.4]])
 */
function harmonicMix(fundamental, components, sampleRate = DEFAULT_SAMPLE_RATE, durationSec = 0.1) {
    const n = Math.round(sampleRate * durationSec);
    const buf = new Float32Array(n);
    for (const [mult, amp] of components) {
        const omega = 2 * Math.PI * fundamental * mult;
        for (let i = 0; i < n; i++) buf[i] += amp * Math.sin(omega * i / sampleRate);
    }
    // Normalize to peak 0.9 to avoid clipping
    let peak = 0;
    for (let i = 0; i < n; i++) if (Math.abs(buf[i]) > peak) peak = Math.abs(buf[i]);
    if (peak > 0) {
        const scale = 0.9 / peak;
        for (let i = 0; i < n; i++) buf[i] *= scale;
    }
    return buf;
}

/** Return freq in Hz for a MIDI note number (A4 = 69 = 440 Hz). */
function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Return the difference in cents between two frequencies. */
function cents(detected, expected) {
    return 1200 * Math.log2(detected / expected);
}

module.exports = {
    DEFAULT_SAMPLE_RATE,
    sine,
    harmonicMix,
    midiToFreq,
    cents,
};
