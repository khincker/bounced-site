/* ============================================================
   comp-console.js — Portable A/B audio comparison module

   Usage:
     const comp = CompConsole.mount(containerEl, {
       trackA: { url: 'a.mp3', label: 'Clean Version' },
       trackB: { url: 'b.mp3', label: 'Explicit Version' },
       alignment: false,
       restrictRegion: false,
       loopStart: 0,
       loopEnd: 1,
       features: { scrubbing: true, beatGrid: true, driftMap: true, markers: true },
       onPlay: () => {},
       onStop: () => {},
       onTrackSwitch: (track) => {},
       onSeek: (sec) => {},
       onMarkerPlace: (sec) => {},
       onMarkerRemove: (sec) => {},
     });

     comp.destroy();
   ============================================================ */

const CompConsole = (() => {

  // ── Constants ──
  const PEAK_BINS = 300;
  const CHEVRON_SVG = '<svg viewBox="0 0 12 10"><path d="M0,0 Q0,2 2,2 L4.5,8 Q6,11 7.5,8 L10,2 Q12,2 12,0 Z"/></svg>';
  const PLAY_SVG = '<svg viewBox="0 0 24 24"><polygon points="8,5 20,12 8,19"/></svg>';
  const PAUSE_SVG = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/></svg>';
  const ARROW_SVG = '<svg viewBox="0 0 12 12"><polygon points="1,3 11,3 6,10"/></svg>';
  const HANDLE_SVG = '<svg viewBox="0 0 14 10"><polygon points="2,0 12,0 7,9"/></svg>';

  // ── Audio Cache (in-memory + IndexedDB) ──
  // In-memory: full AudioBuffer + peaks (instant on remount within same session)
  // IndexedDB: raw bytes + peaks (survives page reload, fast re-decode for collabs)

  const _memCache = new Map();   // url → { buffer: AudioBuffer, peaks: Float32Array, duration, sampleRate, channels }
  const IDB_NAME = 'comp-console-cache';
  const IDB_STORE = 'tracks';
  const IDB_VERSION = 1;

  function _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function _idbGet(url) {
    try {
      const db = await _openIDB();
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(url);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) { return null; }
  }

  async function _idbPut(url, data) {
    try {
      const db = await _openIDB();
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(data, url);
    } catch (e) { /* cache write failure is non-fatal */ }
  }

  // ── Utilities ──

  function fmtTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function extractPeaks(audioBuf, numBins, startSec, endSec) {
    const chan = audioBuf.getChannelData(0);
    const sr = audioBuf.sampleRate;
    const sStart = startSec ? Math.floor(startSec * sr) : 0;
    const sEnd = endSec ? Math.min(Math.floor(endSec * sr), chan.length) : chan.length;
    const regionLen = sEnd - sStart;
    if (regionLen <= 0) return new Float32Array(numBins);
    const binSize = Math.floor(regionLen / numBins);
    const peaks = new Float32Array(numBins);
    for (let i = 0; i < numBins; i++) {
      let max = 0;
      const start = sStart + i * binSize;
      const end = Math.min(start + binSize, sEnd);
      for (let j = start; j < end; j++) {
        const abs = Math.abs(chan[j]);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }
    return peaks;
  }

  // ── Alignment (cross-correlation from In Effect) ──

  function findAlignmentOffset(bufA, bufB) {
    if (!bufA || !bufB) return 0;
    if (Math.abs(bufA.duration - bufB.duration) < 0.05) return 0;

    const sr = bufA.sampleRate;
    const aData = bufA.getChannelData(0);
    const bData = bufB.getChannelData(0);

    const corrScore = (aStart, bStart, len) => {
      let sumAB = 0, sumAA = 0, sumBB = 0;
      for (let i = 0; i < len; i++) {
        const a = aData[aStart + i], b = bData[bStart + i];
        sumAB += a * b; sumAA += a * a; sumBB += b * b;
      }
      const denom = Math.sqrt(sumAA * sumBB);
      return denom > 0 ? sumAB / denom : 0;
    };

    const refineOffset = (aStart, bCenter, patLen) => {
      const radius = Math.floor(0.1 * sr);
      const lo = Math.max(0, bCenter - radius);
      const hi = Math.min(bData.length - patLen, bCenter + radius);
      let best = bCenter, bestC = -Infinity;
      for (let off = lo; off <= hi; off++) {
        let c = 0;
        for (let i = 0; i < patLen; i++) c += aData[aStart + i] * bData[off + i];
        if (c > bestC) { bestC = c; best = off; }
      }
      return best;
    };

    // Strategy 1: Silence detection
    const threshold = 0.01;
    let audioStartA = 0, audioStartB = 0;
    for (let i = 0; i < aData.length; i++) {
      if (Math.abs(aData[i]) > threshold) { audioStartA = i; break; }
    }
    for (let i = 0; i < bData.length; i++) {
      if (Math.abs(bData[i]) > threshold) { audioStartB = i; break; }
    }

    const patLen = Math.min(Math.floor(0.5 * sr), aData.length - audioStartA, bData.length - audioStartB);
    const refinedB = refineOffset(audioStartA, audioStartB, patLen);
    const score = corrScore(audioStartA, refinedB, patLen);

    if (score > 0.7) {
      const finalOffset = refinedB - audioStartA;
      if (finalOffset === 0) return 0;
      return finalOffset / sr;
    }

    // Strategy 2: Full cross-correlation (bidirectional)
    const dsFactor = Math.max(1, Math.floor(sr / 4000));

    // Forward: search for A in B
    const patSampA = Math.min(Math.floor(4.0 * sr), aData.length - audioStartA);
    const patDSA = Math.floor(patSampA / dsFactor);
    const searchLenB = Math.min(Math.floor(60.0 * sr), bData.length);
    const searchDSB = Math.floor(searchLenB / dsFactor);
    const patStDSA = Math.floor(audioStartA / dsFactor);
    const patArrA = new Float32Array(patDSA);
    for (let i = 0; i < patDSA; i++) patArrA[i] = aData[(patStDSA + i) * dsFactor];
    const srcArrB = new Float32Array(searchDSB);
    for (let i = 0; i < searchDSB; i++) srcArrB[i] = bData[i * dsFactor];
    let bestFwd = 0, bestFwdC = -Infinity;
    for (let s = 0; s <= searchDSB - patDSA; s++) {
      let c = 0;
      for (let i = 0; i < patDSA; i++) c += patArrA[i] * srcArrB[s + i];
      if (c > bestFwdC) { bestFwdC = c; bestFwd = s; }
    }

    // Reverse: search for B in A
    const patSampB = Math.min(Math.floor(4.0 * sr), bData.length - audioStartB);
    const patDSB = Math.floor(patSampB / dsFactor);
    const searchLenA = Math.min(Math.floor(60.0 * sr), aData.length);
    const searchDSA = Math.floor(searchLenA / dsFactor);
    const patStDSB = Math.floor(audioStartB / dsFactor);
    const patArrB = new Float32Array(patDSB);
    for (let i = 0; i < patDSB; i++) patArrB[i] = bData[(patStDSB + i) * dsFactor];
    const srcArrA = new Float32Array(searchDSA);
    for (let i = 0; i < searchDSA; i++) srcArrA[i] = aData[i * dsFactor];
    let bestRev = 0, bestRevC = -Infinity;
    for (let s = 0; s <= searchDSA - patDSB; s++) {
      let c = 0;
      for (let i = 0; i < patDSB; i++) c += patArrB[i] * srcArrA[s + i];
      if (c > bestRevC) { bestRevC = c; bestRev = s; }
    }

    const fwdN = patDSA > 0 ? bestFwdC / patDSA : 0;
    const revN = patDSB > 0 ? bestRevC / patDSB : 0;
    let finalOffset;
    if (fwdN >= revN) {
      const coarseB = bestFwd * dsFactor;
      const fpLen = Math.min(Math.floor(0.5 * sr), aData.length - audioStartA);
      finalOffset = refineOffset(audioStartA, coarseB, fpLen) - audioStartA;
    } else {
      const coarseA = bestRev * dsFactor;
      const fpLen = Math.min(Math.floor(0.5 * sr), bData.length - audioStartB);
      const radius = Math.floor(0.1 * sr);
      const lo = Math.max(0, coarseA - radius), hi = Math.min(aData.length - fpLen, coarseA + radius);
      let best = coarseA, bestC = -Infinity;
      for (let off = lo; off <= hi; off++) {
        let c = 0;
        for (let i = 0; i < fpLen; i++) c += bData[audioStartB + i] * aData[off + i];
        if (c > bestC) { bestC = c; best = off; }
      }
      finalOffset = audioStartB - best;
    }

    if (finalOffset === 0) return 0;
    return finalOffset / sr;
  }


  // ── Beat Detection ──

  function detectBeats(audioBuf) {
    if (!audioBuf) return null;
    const sr = audioBuf.sampleRate;
    const chan = audioBuf.getChannelData(0);
    const len = chan.length;

    // Energy-based onset detection
    const hopSize = Math.floor(sr * 0.01); // 10ms hops
    const frameSize = Math.floor(sr * 0.02); // 20ms frames
    const numFrames = Math.floor((len - frameSize) / hopSize);
    const energy = new Float32Array(numFrames);

    for (let f = 0; f < numFrames; f++) {
      let sum = 0;
      const offset = f * hopSize;
      for (let i = 0; i < frameSize; i++) {
        sum += chan[offset + i] * chan[offset + i];
      }
      energy[f] = sum / frameSize;
    }

    // Spectral flux (energy difference)
    const flux = new Float32Array(numFrames);
    for (let f = 1; f < numFrames; f++) {
      flux[f] = Math.max(0, energy[f] - energy[f - 1]);
    }

    // Adaptive threshold — local mean + multiplier
    const windowSize = 100; // ~1 second of frames
    const onsets = [];
    const minOnsetGap = Math.floor(0.1 * sr / hopSize); // 100ms minimum between onsets
    let lastOnset = -minOnsetGap;

    for (let f = 0; f < numFrames; f++) {
      const lo = Math.max(0, f - windowSize);
      const hi = Math.min(numFrames, f + windowSize);
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += flux[j];
      const mean = sum / (hi - lo);
      const threshold = mean * 1.5 + 0.0001;

      if (flux[f] > threshold && (f - lastOnset) >= minOnsetGap) {
        onsets.push(f * hopSize / sr); // time in seconds
        lastOnset = f;
      }
    }

    if (onsets.length < 4) return null;

    // BPM histogram from onset intervals
    const intervals = [];
    for (let i = 1; i < onsets.length; i++) {
      const dt = onsets[i] - onsets[i - 1];
      if (dt > 0.2 && dt < 2.0) intervals.push(dt); // 30-300 BPM range
    }

    if (intervals.length < 2) return null;

    // Cluster intervals to find dominant BPM
    const bpmCounts = {};
    for (const dt of intervals) {
      const bpm = Math.round(60 / dt);
      // Consider half and double time
      for (const candidate of [bpm, bpm * 2, Math.round(bpm / 2)]) {
        if (candidate >= 60 && candidate <= 200) {
          const key = candidate;
          bpmCounts[key] = (bpmCounts[key] || 0) + 1;
        }
      }
    }

    let bestBpm = 120;
    let bestCount = 0;
    for (const [bpm, count] of Object.entries(bpmCounts)) {
      if (count > bestCount) {
        bestCount = count;
        bestBpm = parseInt(bpm);
      }
    }

    // Find downbeat (first strong onset)
    const firstOnset = onsets[0] || 0;

    // Generate quantized grid
    const beatInterval = 60 / bestBpm;
    const duration = audioBuf.duration;

    // Snap first beat to nearest onset
    let gridStart = firstOnset;
    // Walk backwards from first onset to time 0
    while (gridStart - beatInterval > 0) gridStart -= beatInterval;

    const beats = [];
    for (let t = gridStart; t < duration; t += beatInterval) {
      if (t >= 0) beats.push(t);
    }

    return {
      bpm: bestBpm,
      beats: beats,
      beatsPerBar: 4, // assume 4/4 for now
      firstDownbeat: gridStart,
    };
  }


  // ── Diff analysis for Drift Map ──
  //
  // Computes per-bin RMS of the actual sample-level difference between two tracks.
  // Uses time-based addressing so buffers with different sample counts stay aligned.
  // Returns { data: Float32Array, max: number } — raw (un-normalized) RMS values
  // so that zoomed regions use the same scale as the full track.

  function computeDiffData(bufA, bufB, numBins, alignedDuration, offsetB, startSec, endSec) {
    if (!bufA || !bufB) return null;
    const srA = bufA.sampleRate;
    const srB = bufB.sampleRate;
    const chanA = bufA.getChannelData(0);
    const chanB = bufB.getChannelData(0);

    // Alignment shifts (same logic as playback engine)
    const aShiftSec = Math.max(0, -(offsetB || 0));
    const bShiftSec = Math.max(0, (offsetB || 0));

    // Common aligned duration
    const dur = alignedDuration || Math.min(bufA.duration - aShiftSec, bufB.duration - bShiftSec);
    const regionStart = startSec || 0;
    const regionEnd = endSec || dur;
    const regionDur = regionEnd - regionStart;
    if (regionDur <= 0) return null;

    const binDur = regionDur / numBins; // seconds per bin
    const diff = new Float32Array(numBins);
    let maxVal = 0;

    for (let i = 0; i < numBins; i++) {
      const tStart = regionStart + i * binDur;
      const tEnd = tStart + binDur;

      // Sample ranges for this bin — apply alignment shifts
      const aStart = Math.floor((tStart + aShiftSec) * srA);
      const aEnd = Math.min(Math.floor((tEnd + aShiftSec) * srA), chanA.length);
      const bStart = Math.floor((tStart + bShiftSec) * srB);
      const bEnd = Math.min(Math.floor((tEnd + bShiftSec) * srB), chanB.length);
      const count = Math.min(aEnd - aStart, bEnd - bStart);
      if (count <= 0) continue;

      let sumSq = 0;
      for (let j = 0; j < count; j++) {
        const d = chanA[aStart + j] - chanB[bStart + j];
        sumSq += d * d;
      }
      diff[i] = Math.sqrt(sumSq / count); // RMS of difference
      if (diff[i] > maxVal) maxVal = diff[i];
    }

    return { data: diff, max: maxVal };
  }


  // ══════════════════════════════════════════════════
  //  CompInstance — one mounted comp console
  // ══════════════════════════════════════════════════

  class CompInstance {
    constructor(container, opts) {
      this.container = container;
      this.opts = Object.assign({
        heading: '',             // e.g. 'COMP' — small label above track names
        title: '',               // e.g. 'LOOK AWAY' — shared track title
        meta: null,              // e.g. ['113 BPM', 'A♭ major', '4/4', 'INDIE ROCK']
        trackA: null,
        trackB: null,
        alignment: false,
        restrictRegion: false,
        loopStart: 0,
        loopEnd: 1,
        activeTrack: 'A',
        markers: [],
        isZoomed: false,
        zoomStart: 0,
        zoomEnd: 1,
        beatGridVisible: false,
        driftMapVisible: false,
        lastPlayheadSec: 0,
        features: { scrubbing: true, beatGrid: true, driftMap: true, markers: true },
        onPlay: null,
        onStop: null,
        onTrackSwitch: null,
        onSeek: null,
        onMarkerPlace: null,
        onMarkerRemove: null,
      }, opts);

      // Audio state
      this.ctx = null;
      this.sourceA = null;
      this.sourceB = null;
      this.gainA = null;
      this.gainB = null;
      this.bufferA = null;
      this.bufferB = null;
      this.peaksA = null;
      this.peaksB = null;
      this.offsetB = 0;
      this.startedAt = null;
      this.startOffset = 0;
      this.animFrame = null;
      this.isPlaying = false;
      this.activeTrack = this.opts.activeTrack || 'A';
      this.duration = 0;
      this.lastPlayheadSec = this.opts.lastPlayheadSec || 0;

      // Loop state (0-1 fractions)
      this.loopStart = this.opts.loopStart;
      this.loopEnd = this.opts.loopEnd;
      this.loopStartSec = 0;
      this.loopEndSec = 0;

      // Single-track mode (no A/B switching)
      this.isSingleTrack = !this.opts.trackA || !this.opts.trackB;

      // UI state
      this.draggingHandle = null;
      this.frozenToastTimer = null;
      this.beatGrid = null;          // result from detectBeats()
      this.diffData = null;          // Float32Array of raw RMS diff values
      this.diffMax = 0;              // max RMS from full-track diff (used as normalization reference)
      this.beatGridVisible = !!this.opts.beatGridVisible;
      this.driftMapVisible = !!this.opts.driftMapVisible;
      this.markers = [];             // array of { sec, el }
      this.ghostMarker = null;       // { sec, el } or null

      // Zoom state
      this.isZoomed = !!this.opts.isZoomed;
      this.zoomStart = this.opts.zoomStart || 0;
      this.zoomEnd = (this.opts.zoomEnd != null) ? this.opts.zoomEnd : 1;
      this.zoomedPeaksA = null;
      this.zoomedPeaksB = null;

      // Scrub state
      this.isScrubbing = false;
      this.scrubAudioTimer = null;
      this.scrubSource = null;
      this.scrubGain = null;

      // DOM references (set during render)
      this.els = {};

      // Bound handlers (for cleanup)
      this._onKeydown = this._handleKeydown.bind(this);
      this._onResize = this._handleResize.bind(this);
      this._onHandleDrag = this._handleDrag.bind(this);
      this._onHandleDragEnd = this._handleDragEnd.bind(this);
      this._onScrubMove = this._handleScrubMove.bind(this);
      this._onScrubEnd = this._handleScrubEnd.bind(this);

      this._render();
      this._bindEvents();
      this._loadAudio();
    }

    // ── Audio Engine ──

    _createContext() {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }

    async _ensureContext() {
      this._createContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    }

    _setLoadingProgress(pct) {
      if (!this.els.loadingFill) return;
      this.els.loadingBar.classList.add('visible');
      this.els.loadingFill.style.width = Math.min(100, Math.round(pct)) + '%';
    }

    _setLoadingStatus(text) {
      if (!this.els.loadingText) return;
      this.els.loadingText.innerHTML = text + '<span class="dot-anim"></span>';
    }

    async _loadAudio() {
      this._createContext();

      const trackCount = (this.opts.trackA ? 1 : 0) + (this.opts.trackB ? 1 : 0);
      let tracksLoaded = 0;

      const decode = (arrayBuf, label) => {
        return new Promise((resolve, reject) => {
          this.ctx.decodeAudioData(arrayBuf, resolve, (err) => {
            reject(new Error('decodeAudioData failed for ' + label + ': ' + err));
          });
        });
      };

      const load = async (url, label) => {
        if (!url || url === '#') return null;

        // 1. Check in-memory cache (instant — same page session)
        const mem = _memCache.get(url);
        if (mem) {
          tracksLoaded++;
          this._setLoadingProgress((tracksLoaded / trackCount) * 70);
          this._setLoadingStatus(label + ' (cached)');
          return mem.buffer;
        }

        // 2. Check IndexedDB cache (skip network, just re-decode)
        const idb = await _idbGet(url);
        if (idb && idb.rawBytes) {
          this._setLoadingStatus('Decoding ' + label + ' (cached)');
          const buffer = await decode(idb.rawBytes, label);
          _memCache.set(url, { buffer, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels });
          tracksLoaded++;
          this._setLoadingProgress((tracksLoaded / trackCount) * 70);
          return buffer;
        }

        // 3. Fetch from network with progress
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + label);
        const total = parseInt(res.headers.get('content-length') || '0', 10);
        let loaded = 0;

        let arrayBuf;
        if (total && res.body) {
          const reader = res.body.getReader();
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            const trackPct = loaded / total;
            const basePct = (tracksLoaded / trackCount) * 70;
            const slicePct = (trackPct / trackCount) * 70;
            this._setLoadingProgress(basePct + slicePct);
            const mb = (loaded / (1024 * 1024)).toFixed(1);
            const totalMb = (total / (1024 * 1024)).toFixed(1);
            this._setLoadingStatus('Downloading ' + label + ' (' + mb + ' / ' + totalMb + ' MB)');
          }
          const combined = new Uint8Array(loaded);
          let offset = 0;
          for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
          arrayBuf = combined.buffer;
        } else {
          this._setLoadingStatus('Downloading ' + label);
          arrayBuf = await res.arrayBuffer();
        }

        if (!arrayBuf.byteLength) throw new Error('Empty response for ' + label);
        tracksLoaded++;
        this._setLoadingProgress((tracksLoaded / trackCount) * 70);
        this._setLoadingStatus('Decoding ' + label);
        // Copy raw bytes before decode (decodeAudioData may neuter the ArrayBuffer)
        const rawCopy = arrayBuf.slice(0);
        const buffer = await decode(arrayBuf, label);

        // Store in both caches
        _memCache.set(url, { buffer, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels });
        _idbPut(url, { rawBytes: rawCopy, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels });

        return buffer;
      };

      try {
        let bufA = null, bufB = null;
        if (this.opts.trackA) {
          bufA = await load(this.opts.trackA.url, this.opts.trackA.label || 'A')
            .catch(e => { console.error('Track A load failed:', e); return null; });
        }
        if (this.opts.trackB) {
          bufB = await load(this.opts.trackB.url, this.opts.trackB.label || 'B')
            .catch(e => { console.error('Track B load failed:', e); return null; });
        }

        this._setLoadingProgress(70);
        this.bufferA = bufA;
        this.bufferB = bufB;

        const wantedA = !!this.opts.trackA, wantedB = !!this.opts.trackB;
        if ((wantedA && !bufA && !wantedB) || (wantedB && !bufB && !wantedA) || (wantedA && !bufA && wantedB && !bufB)) {
          this.els.loadingText.textContent = 'Could not load audio — check console';
          return;
        }

        if (this.opts.alignment && bufA && bufB) {
          this._setLoadingStatus('Aligning tracks');
          this._setLoadingProgress(75);
          await new Promise(r => setTimeout(r, 0));
          this.offsetB = findAlignmentOffset(bufA, bufB);
        } else {
          this.offsetB = 0;
        }

        const aShift = Math.max(0, -this.offsetB);
        const bShift = Math.max(0, this.offsetB);
        if (bufA && bufB) {
          this.duration = Math.min(bufA.duration - aShift, bufB.duration - bShift);
        } else if (bufA) {
          this.duration = bufA.duration - aShift;
        } else if (bufB) {
          this.duration = bufB.duration - bShift;
        }

        this._setLoadingProgress(80);
        this._setLoadingStatus('Rendering waveforms');
        await new Promise(r => setTimeout(r, 0));
        if (bufA) this.peaksA = extractPeaks(bufA, PEAK_BINS, aShift, aShift + this.duration);
        if (bufB) this.peaksB = extractPeaks(bufB, PEAK_BINS, bShift, bShift + this.duration);

        this.loopStartSec = this.loopStart * this.duration;
        this.loopEndSec = this.loopEnd * this.duration;

        if (this.opts.features.driftMap && bufA && bufB) {
          this._setLoadingProgress(85);
          this._setLoadingStatus('Computing drift map');
          await new Promise(r => setTimeout(r, 0));
          const result = computeDiffData(bufA, bufB, PEAK_BINS, this.duration, this.offsetB);
          if (result) {
            this.diffData = result.data;
            this.diffMax = result.max;
          }
        }
        if (this.opts.features.beatGrid && bufA) {
          setTimeout(() => {
            this.beatGrid = detectBeats(bufA);
            if (this.beatGridVisible) this._redrawWaveforms();
          }, 50);
        }

        this._setLoadingProgress(100);
        this.els.time.textContent = '0:00 / ' + fmtTime(this.duration);
        this._updateLoopRegion();
        this.els.loading.classList.add('hidden');
        this._applyRestoredState();

      } catch (e) {
        console.error('Audio load error:', e);
        this.els.loadingText.textContent = 'Audio unavailable';
      }
    }

    play(offset) {
      this._ensureContext().then(() => {
        this.stop();

        this.gainA = this.ctx.createGain();
        this.gainB = this.ctx.createGain();
        this.gainA.connect(this.ctx.destination);
        this.gainB.connect(this.ctx.destination);
        this._applyActiveTrack();

        const aShift = Math.max(0, -this.offsetB);
        const bShift = Math.max(0, this.offsetB);
        const startAt = (offset !== undefined) ? offset : this.loopStartSec;

        if (this.bufferA) {
          this.sourceA = this.ctx.createBufferSource();
          this.sourceA.buffer = this.bufferA;
          this.sourceA.loop = true;
          this.sourceA.loopStart = this.loopStartSec + aShift;
          this.sourceA.loopEnd = Math.min(this.bufferA.duration, this.loopEndSec + aShift);
          this.sourceA.connect(this.gainA);
          this.sourceA.start(0, startAt + aShift);
        }
        if (this.bufferB) {
          this.sourceB = this.ctx.createBufferSource();
          this.sourceB.buffer = this.bufferB;
          this.sourceB.loop = true;
          this.sourceB.loopStart = this.loopStartSec + bShift;
          this.sourceB.loopEnd = Math.min(this.bufferB.duration, this.loopEndSec + bShift);
          this.sourceB.connect(this.gainB);
          this.sourceB.start(0, startAt + bShift);
        }

        this.startOffset = startAt;
        this.startedAt = this.ctx.currentTime;
        this.isPlaying = true;

        this.els.tracks.classList.add('playing');
        this.els.tracks.classList.remove('has-position');
        this._removeGhostMarker();

        this._updatePlayBtn(true);
        this._updatePlayhead();
        if (this.opts.onPlay) this.opts.onPlay();
      });
    }

    stop() {
      const wasPlaying = this.isPlaying;

      if (this.sourceA) { try { this.sourceA.stop(); } catch(e){} this.sourceA = null; }
      if (this.sourceB) { try { this.sourceB.stop(); } catch(e){} this.sourceB = null; }
      if (this.gainA) { this.gainA.disconnect(); this.gainA = null; }
      if (this.gainB) { this.gainB.disconnect(); this.gainB = null; }
      if (this.animFrame) { cancelAnimationFrame(this.animFrame); this.animFrame = null; }

      // Persist playhead position
      if (wasPlaying) {
        this.lastPlayheadSec = this._getPlayheadSec();
      }

      this.isPlaying = false;
      this.els.tracks.classList.remove('playing');

      // Show paused playhead if we have a position
      if (this.lastPlayheadSec > 0) {
        this.els.tracks.classList.add('has-position');
        const viewFrac = this._toViewFrac(this.lastPlayheadSec / this.duration);
        this.els.playheadA.style.left = (viewFrac * 100) + '%';
        this.els.playheadB.style.left = (viewFrac * 100) + '%';
      }

      // Show ghost marker at stop position
      if (wasPlaying && this.opts.features.markers && this.lastPlayheadSec > 0) {
        this._showGhostMarker(this.lastPlayheadSec);
      }

      if (wasPlaying) {
        this._updatePlayBtn(false);
        if (this.opts.onStop) this.opts.onStop();
      }
    }

    _applyActiveTrack() {
      if (this.gainA) this.gainA.gain.value = (this.activeTrack === 'A') ? 1 : 0;
      if (this.gainB) this.gainB.gain.value = (this.activeTrack === 'B') ? 1 : 0;
    }

    switchTrack(track) {
      if (this.isSingleTrack && track === 'B') return;
      this.activeTrack = track;
      this._applyActiveTrack();
      this.els.abBtnA.className = 'comp-ab-btn' + (track === 'A' ? ' active-a' : '');
      this.els.abBtnB.className = 'comp-ab-btn' + (track === 'B' ? ' active-b' : '');
      this.els.badgeA.className = 'comp-track-badge' + (track === 'A' ? ' active-a' : '');
      this.els.badgeB.className = 'comp-track-badge' + (track === 'B' ? ' active-b' : '');
      this._redrawWaveforms();
      if (this.opts.onTrackSwitch) this.opts.onTrackSwitch(track);
    }

    _getPlayheadSec() {
      if (this.startedAt === null || !this.ctx) return this.loopStartSec;
      const elapsed = this.ctx.currentTime - this.startedAt;
      const loopDur = this.loopEndSec - this.loopStartSec;
      if (loopDur <= 0) return this.loopStartSec;
      const raw = this.startOffset + elapsed;
      if (raw >= this.loopEndSec) {
        return this.loopStartSec + ((raw - this.loopStartSec) % loopDur);
      }
      return raw;
    }

    seekTo(fraction) {
      const sec = fraction * this.duration;
      const clamped = Math.max(this.loopStartSec, Math.min(sec, this.loopEndSec));
      this.lastPlayheadSec = clamped;
      if (this.isPlaying) {
        this.play(clamped);
      } else {
        // Update paused playhead in viewport coords
        const viewFrac = this._toViewFrac(clamped / this.duration);
        this.els.tracks.classList.add('has-position');
        this.els.playheadA.style.left = (viewFrac * 100) + '%';
        this.els.playheadB.style.left = (viewFrac * 100) + '%';
        this.els.time.textContent = fmtTime(clamped) + ' / ' + fmtTime(this.duration);
      }
      if (this.opts.onSeek) this.opts.onSeek(clamped);
    }

    setLoopRegion(startSec, endSec) {
      this.loopStartSec = startSec;
      this.loopEndSec = endSec;
      if (this.isPlaying) {
        const sec = this._getPlayheadSec();
        const newPos = Math.max(startSec, Math.min(sec, endSec));
        this.play(newPos);
      }
    }

    // ── Scrubbing ──

    _startScrub(e, container) {
      if (!this.duration || !this.opts.features.scrubbing) return;
      this.isScrubbing = true;
      document.addEventListener('mousemove', this._onScrubMove);
      document.addEventListener('mouseup', this._onScrubEnd);
      document.addEventListener('touchmove', this._onScrubMove, { passive: false });
      document.addEventListener('touchend', this._onScrubEnd);
      this._performScrub(e);
    }

    _handleScrubMove(e) {
      if (!this.isScrubbing) return;
      e.preventDefault();
      this._performScrub(e);
    }

    _handleScrubEnd(e) {
      if (!this.isScrubbing) return;
      this.isScrubbing = false;
      document.removeEventListener('mousemove', this._onScrubMove);
      document.removeEventListener('mouseup', this._onScrubEnd);
      document.removeEventListener('touchmove', this._onScrubMove);
      document.removeEventListener('touchend', this._onScrubEnd);

      // Stop scrub audio
      this._stopScrubAudio();

      // Show ghost marker at scrub end position
      if (!this.isPlaying && this.opts.features.markers && this.lastPlayheadSec > 0) {
        this._showGhostMarker(this.lastPlayheadSec);
      }
    }

    _performScrub(e) {
      const wrapper = this.els.tracksWrapper;
      const rect = wrapper.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      let viewFrac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      let frac = this._fromViewFrac(viewFrac);

      if (this.opts.restrictRegion) {
        frac = Math.max(this.loopStart, Math.min(frac, this.loopEnd));
      }

      this.seekTo(frac);

      // Play short audio burst while scrubbing (when paused)
      if (!this.isPlaying) {
        this._playScrubBurst(frac * this.duration);
      }
    }

    _playScrubBurst(sec) {
      this._stopScrubAudio();
      if (!this.ctx) return;

      const buf = (this.activeTrack === 'A') ? this.bufferA : this.bufferB;
      if (!buf) return;

      const aShift = Math.max(0, -this.offsetB);
      const bShift = Math.max(0, this.offsetB);
      const shift = (this.activeTrack === 'A') ? aShift : bShift;

      this.scrubGain = this.ctx.createGain();
      this.scrubGain.gain.value = 0.8;
      this.scrubGain.connect(this.ctx.destination);

      this.scrubSource = this.ctx.createBufferSource();
      this.scrubSource.buffer = buf;
      this.scrubSource.connect(this.scrubGain);
      this.scrubSource.start(0, sec + shift, 0.08); // 80ms burst

      // Fade out
      this.scrubGain.gain.setValueAtTime(0.8, this.ctx.currentTime);
      this.scrubGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.08);

      clearTimeout(this.scrubAudioTimer);
      this.scrubAudioTimer = setTimeout(() => this._stopScrubAudio(), 100);
    }

    _stopScrubAudio() {
      if (this.scrubSource) { try { this.scrubSource.stop(); } catch(e){} this.scrubSource = null; }
      if (this.scrubGain) { this.scrubGain.disconnect(); this.scrubGain = null; }
      clearTimeout(this.scrubAudioTimer);
    }

    // ── Markers ──

    _showGhostMarker(sec) {
      this._removeGhostMarker();
      const viewFrac = this._toViewFrac(sec / this.duration);
      const el = document.createElement('div');
      el.className = 'comp-marker ghost';
      el.title = 'Click to place';
      el.style.left = (viewFrac * 100) + '%';
      el.innerHTML = '<div class="comp-marker-chevron">' + CHEVRON_SVG + '</div>';
      el.addEventListener('click', () => this._pinMarker(sec));
      this.els.markerRail.appendChild(el);
      this.ghostMarker = { sec, el };
    }

    _removeGhostMarker() {
      if (this.ghostMarker) {
        this.ghostMarker.el.remove();
        this.ghostMarker = null;
      }
    }

    _pinMarker(sec) {
      this._removeGhostMarker();
      const fullFrac = sec / this.duration;
      const viewFrac = this._toViewFrac(fullFrac);
      const el = document.createElement('div');
      el.className = 'comp-marker';
      el.style.left = (viewFrac * 100) + '%';
      el.innerHTML = '<div class="comp-marker-chevron">' + CHEVRON_SVG + '</div>';

      // Double-click to remove
      el.addEventListener('dblclick', () => {
        el.remove();
        this.markers = this.markers.filter(m => m.el !== el);
        if (this.opts.onMarkerRemove) this.opts.onMarkerRemove(sec);
      });

      // Click to seek
      el.addEventListener('click', () => {
        this.seekTo(fullFrac);
      });

      this.els.markerRail.appendChild(el);
      this.markers.push({ sec, el });
      if (this.opts.onMarkerPlace) this.opts.onMarkerPlace(sec);
    }

    // ── State Restoration ──

    _applyRestoredState() {
      // Active track
      if (this.opts.activeTrack && this.opts.activeTrack !== 'A') {
        this.switchTrack(this.opts.activeTrack);
      }

      // Drift map visibility
      if (this.driftMapVisible && this.els.driftBtn) {
        this._setDriftMapVisible(true);
      }

      // Markers
      if (this.opts.markers && this.opts.markers.length && this.els.markerRail) {
        for (const sec of this.opts.markers) {
          if (typeof sec === 'number' && sec >= 0 && sec <= this.duration) {
            this._pinMarker(sec);
          }
        }
      }

      // Zoom (must come after loop region is already set)
      if (this.isZoomed && this.zoomEnd > this.zoomStart) {
        const zStartSec = this.zoomStart * this.duration;
        const zEndSec = this.zoomEnd * this.duration;
        const aShift = Math.max(0, -this.offsetB);
        const bShift = Math.max(0, this.offsetB);
        if (this.bufferA) this.zoomedPeaksA = this._extractZoomedPeaks(this.bufferA, zStartSec + aShift, zEndSec + aShift);
        if (this.bufferB) this.zoomedPeaksB = this._extractZoomedPeaks(this.bufferB, zStartSec + bShift, zEndSec + bShift);

        if (this.bufferA && this.bufferB) {
          const result = computeDiffData(this.bufferA, this.bufferB, PEAK_BINS,
            this.duration, this.offsetB, zStartSec, zEndSec);
          this.zoomedDiffData = result ? result.data : null;
        }

        this._updateZoomBtn();
      }

      // Playhead position
      if (this.lastPlayheadSec > 0 && this.duration > 0) {
        const viewFrac = this._toViewFrac(this.lastPlayheadSec / this.duration);
        this.els.tracks.classList.add('has-position');
        this.els.playheadA.style.left = (viewFrac * 100) + '%';
        this.els.playheadB.style.left = (viewFrac * 100) + '%';
        this.els.time.textContent = fmtTime(this.lastPlayheadSec) + ' / ' + fmtTime(this.duration);
      }

      // Final sync
      this._updateLoopRegion();
    }

    // ── Waveform Drawing ──

    _drawWaveform(canvas, peaks, track) {
      if (!canvas || !peaks) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const w = rect.width;
      const h = rect.height;
      const numBars = peaks.length;
      const barW = Math.max(1, (w / numBars) - 1);
      const gap = (w - barW * numBars) / numBars;
      const isActive = this.activeTrack === track;

      // Colors from CSS vars
      const styles = getComputedStyle(this.container);
      const accent = styles.getPropertyValue('--comp-accent').trim() || '#2dd4bf';
      const trackB = styles.getPropertyValue('--comp-track-b').trim() || '#f472b6';
      const baseColor = track === 'A' ? accent : trackB;

      // Parse base color for alpha manipulation
      const parseColor = (c) => {
        // Handle rgb/rgba
        const rgbMatch = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgbMatch) return { r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3] };
        // Handle hex
        const hex = c.replace('#', '');
        if (hex.length === 6) return { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16) };
        return { r: 45, g: 212, b: 191 };
      };
      const { r, g, b } = parseColor(baseColor);

      const activeColor = `rgba(${r},${g},${b},0.7)`;
      const dimColor = `rgba(${r},${g},${b},0.18)`;
      const inactiveColor = 'rgba(232,232,236,0.15)';

      // Drift map colors — cross-color: highlight diffs with the OTHER track's color
      const otherColor = track === 'A' ? trackB : accent;
      const { r: or, g: og, b: ob } = parseColor(otherColor);
      // Threshold: fraction of the full-track max RMS. Below this = normal coloring.
      // Must be high enough to reject MP3 codec artifacts (~0.15-0.40 of max)
      // but low enough to catch real differences (word changes, mix changes).
      const diffThreshold = 0.5;
      const diffScale = this.diffMax || 1; // raw RMS max from full-track analysis

      // Diff data — use zoomed version when available
      const activeDiff = (this.isZoomed && this.zoomedDiffData) ? this.zoomedDiffData : this.diffData;

      for (let i = 0; i < numBars; i++) {
        const x = i * (barW + gap);
        const viewFrac = i / numBars;  // fraction within the viewport (0-1)
        const fullFrac = this._fromViewFrac(viewFrac); // fraction within full duration

        // Peaks are already aligned — srcBin = display bin
        const srcBin = i;
        if (srcBin < 0 || srcBin >= numBars) continue;

        const inLoop = fullFrac >= this.loopStart && fullFrac <= this.loopEnd;
        const barH = Math.max(2, peaks[srcBin] * h * 0.9);
        const y = (h - barH) / 2;

        // Normal color first (used in both modes for non-diff bars)
        // TODO: dual highlight — show both tracks bright when drift visible & stopped
        // const showBright = isActive || (this.driftMapVisible && !this.isPlaying);
        let barColor;
        if (inLoop && isActive) barColor = activeColor;
        else if (inLoop) barColor = inactiveColor;
        else barColor = dimColor;

        if (this.driftMapVisible && activeDiff) {
          // Drift Map mode — normalize raw RMS against the full-track max
          const rawDiff = activeDiff[srcBin] || 0;
          const normalized = diffScale > 0 ? rawDiff / diffScale : 0;
          if (normalized > diffThreshold) {
            const intensity = (normalized - diffThreshold) / (1 - diffThreshold);
            const alpha = 0.3 + intensity * 0.55;
            ctx.fillStyle = `rgba(${or},${og},${ob},${alpha.toFixed(3)})`;
          } else {
            // Below threshold — keep normal waveform coloring
            ctx.fillStyle = barColor;
          }
        } else {
          ctx.fillStyle = barColor;
        }

        ctx.fillRect(x, y, barW, barH);
      }

      // Beat grid overlay
      if (this.beatGridVisible && this.beatGrid) {
        const beats = this.beatGrid.beats;
        const beatsPerBar = this.beatGrid.beatsPerBar;
        const firstDownbeat = this.beatGrid.firstDownbeat;

        for (let bi = 0; bi < beats.length; bi++) {
          const t = beats[bi];
          const beatFrac = t / this.duration;
          const viewX = this._toViewFrac(beatFrac) * w;
          if (viewX < 0 || viewX > w) continue;

          // Determine if downbeat
          const beatInBar = Math.round((t - firstDownbeat) / (60 / this.beatGrid.bpm)) % beatsPerBar;
          const isDownbeat = (beatInBar === 0);

          ctx.beginPath();
          if (isDownbeat) {
            ctx.strokeStyle = 'rgba(255,255,255,0.45)';
            ctx.lineWidth = 1;
            ctx.moveTo(viewX, 0);
            ctx.lineTo(viewX, h * 0.18);
          } else {
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 0.5;
            ctx.moveTo(viewX, 0);
            ctx.lineTo(viewX, h * 0.08);
          }
          ctx.stroke();
        }
      }
    }

    _drawRandomWaveform(canvas, track) {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const w = rect.width;
      const h = rect.height;
      const numBars = PEAK_BINS;
      const barW = Math.max(1, (w / numBars) - 1);
      const gap = (w - barW * numBars) / numBars;

      const styles = getComputedStyle(this.container);
      const accent = styles.getPropertyValue('--comp-accent').trim() || '#2dd4bf';
      const trackBColor = styles.getPropertyValue('--comp-track-b').trim() || '#f472b6';
      const parseColor = (c) => {
        const rgbMatch = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgbMatch) return { r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3] };
        const hex = c.replace('#', '');
        if (hex.length === 6) return { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16) };
        return { r: 45, g: 212, b: 191 };
      };
      const { r, g, b } = parseColor(track === 'A' ? accent : trackBColor);
      const color = `rgba(${r},${g},${b},0.15)`;

      for (let i = 0; i < numBars; i++) {
        const x = i * (barW + gap);
        const barH = (0.3 + Math.random() * 0.65) * h * 0.8;
        const y = (h - barH) / 2;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, barW, barH);
      }
    }

    _redrawWaveforms() {
      const pA = (this.isZoomed && this.zoomedPeaksA) ? this.zoomedPeaksA : this.peaksA;
      const pB = (this.isZoomed && this.zoomedPeaksB) ? this.zoomedPeaksB : this.peaksB;
      if (pA) this._drawWaveform(this.els.canvasA, pA, 'A');
      else this._drawRandomWaveform(this.els.canvasA, 'A');
      if (!this.isSingleTrack) {
        if (pB) this._drawWaveform(this.els.canvasB, pB, 'B');
        else this._drawRandomWaveform(this.els.canvasB, 'B');
      }
    }

    // ── Playhead ──

    _updatePlayhead() {
      if (!this.isPlaying) return;
      const sec = this._getPlayheadSec();
      this.lastPlayheadSec = sec;
      const fullFrac = sec / this.duration;
      const viewFrac = this._toViewFrac(fullFrac);

      this.els.playheadA.style.left = (viewFrac * 100) + '%';
      this.els.playheadB.style.left = (viewFrac * 100) + '%';
      this.els.time.textContent = fmtTime(sec) + ' / ' + fmtTime(this.duration);

      this.animFrame = requestAnimationFrame(() => this._updatePlayhead());
    }

    _updatePlayBtn(playing) {
      if (playing) {
        this.els.playBtn.classList.add('playing');
        this.els.playBtn.innerHTML = PAUSE_SVG;
      } else {
        this.els.playBtn.classList.remove('playing');
        this.els.playBtn.innerHTML = PLAY_SVG;
      }
    }

    // ── Loop Region ──

    _updateLoopRegion() {
      // Map loop handles and dim overlays to viewport coordinates
      const viewLeft = this._toViewFrac(this.loopStart);
      const viewRight = this._toViewFrac(this.loopEnd);

      const leftPct = (Math.max(0, viewLeft) * 100) + '%';
      const rightPct = ((1 - Math.min(1, viewRight)) * 100) + '%';

      this.els.dimLeftA.style.width = leftPct;
      this.els.dimLeftB.style.width = leftPct;
      this.els.dimRightA.style.width = rightPct;
      this.els.dimRightB.style.width = rightPct;

      this.els.handleLeft.style.left = (Math.max(0, viewLeft) * 100) + '%';
      this.els.handleRight.style.left = (Math.min(1, viewRight) * 100) + '%';

      // Hide handles if they're outside the zoomed viewport
      this.els.handleLeft.style.display = (viewLeft < -0.01 || viewLeft > 1.01) ? 'none' : '';
      this.els.handleRight.style.display = (viewRight < -0.01 || viewRight > 1.01) ? 'none' : '';

      // Handle line height
      const lineH = this.els.tracks.offsetHeight || 136;
      this.els.handleLineLeft.style.height = lineH + 'px';
      this.els.handleLineRight.style.height = lineH + 'px';

      // Timeline labels — show zoomed range when zoomed
      if (this.isZoomed) {
        this.els.timeStart.textContent = fmtTime(this.zoomStart * this.duration);
        this.els.timeEnd.textContent = fmtTime(this.zoomEnd * this.duration);
      } else {
        this.els.timeStart.textContent = '0:00';
        this.els.timeEnd.textContent = fmtTime(this.duration);
      }
      this.els.loopStartTime.textContent = fmtTime(this.loopStart * this.duration);
      this.els.loopEndTime.textContent = fmtTime(this.loopEnd * this.duration);

      // Update markers positions
      for (const m of this.markers) {
        const mFrac = this._toViewFrac(m.sec / this.duration);
        m.el.style.left = (mFrac * 100) + '%';
        m.el.style.display = (mFrac < -0.01 || mFrac > 1.01) ? 'none' : '';
      }
      if (this.ghostMarker) {
        const gFrac = this._toViewFrac(this.ghostMarker.sec / this.duration);
        this.ghostMarker.el.style.left = (gFrac * 100) + '%';
        this.ghostMarker.el.style.display = (gFrac < -0.01 || gFrac > 1.01) ? 'none' : '';
      }

      this._redrawWaveforms();
    }

    // ── Zoom ──

    // Convert a full-duration fraction (0-1) to a viewport fraction when zoomed
    _toViewFrac(frac) {
      if (!this.isZoomed) return frac;
      const range = this.zoomEnd - this.zoomStart;
      if (range <= 0) return 0;
      return (frac - this.zoomStart) / range;
    }

    // Convert a viewport fraction (0-1 within zoomed view) to a full-duration fraction
    _fromViewFrac(viewFrac) {
      if (!this.isZoomed) return viewFrac;
      return this.zoomStart + viewFrac * (this.zoomEnd - this.zoomStart);
    }

    _extractZoomedPeaks(buffer, startSec, endSec) {
      // Extract peaks for a time region (in seconds within the aligned timeline)
      if (!buffer) return null;
      return extractPeaks(buffer, PEAK_BINS, startSec, endSec);
    }

    _zoomToLoop() {
      if (this.isZoomed) {
        this._unzoom();
        return;
      }
      // Need a meaningful loop region to zoom into
      if (this.loopEnd - this.loopStart < 0.02) return;

      this.zoomStart = this.loopStart;
      this.zoomEnd = this.loopEnd;
      this.isZoomed = true;

      // Re-extract peaks at higher resolution for the zoomed region (with alignment shifts)
      const zStartSec = this.zoomStart * this.duration;
      const zEndSec = this.zoomEnd * this.duration;
      const aShift = Math.max(0, -this.offsetB);
      const bShift = Math.max(0, this.offsetB);
      if (this.bufferA) this.zoomedPeaksA = this._extractZoomedPeaks(this.bufferA, zStartSec + aShift, zEndSec + aShift);
      if (this.bufferB) this.zoomedPeaksB = this._extractZoomedPeaks(this.bufferB, zStartSec + bShift, zEndSec + bShift);

      // Recompute diff data for zoomed region from raw PCM (convert fractions to seconds)
      if (this.bufferA && this.bufferB) {
        const result = computeDiffData(this.bufferA, this.bufferB, PEAK_BINS,
          this.duration, this.offsetB,
          this.zoomStart * this.duration, this.zoomEnd * this.duration);
        this.zoomedDiffData = result ? result.data : null;
        // NOTE: we keep this.diffMax from the full-track computation so zoom uses the same scale
      }

      this._updateZoomBtn();
      this._updateLoopRegion();
    }

    _unzoom() {
      this.isZoomed = false;
      this.zoomStart = 0;
      this.zoomEnd = 1;
      this.zoomedPeaksA = null;
      this.zoomedPeaksB = null;
      this.zoomedDiffData = null;
      this._updateZoomBtn();
      this._updateLoopRegion();
    }

    _zoomToDiffRegion(viewFrac) {
      // Given a click position in the viewport, find the diff region around it
      // and set loop + zoom to ±2 seconds
      const fullFrac = this._fromViewFrac(viewFrac);
      const sec = fullFrac * this.duration;
      const padding = 2; // seconds on each side
      const startSec = Math.max(0, sec - padding);
      const endSec = Math.min(this.duration, sec + padding);

      // Set loop to this region
      this.loopStart = startSec / this.duration;
      this.loopEnd = endSec / this.duration;
      this.loopStartSec = startSec;
      this.loopEndSec = endSec;
      this.setLoopRegion(startSec, endSec);

      // Now zoom to it
      this.isZoomed = false; // reset first so _zoomToLoop picks up new loop
      this._zoomToLoop();
    }

    _updateZoomBtn() {
      if (!this.els.zoomBtn) return;
      if (this.isZoomed) {
        this.els.zoomBtn.textContent = 'Unzoom';
        this.els.zoomBtn.classList.add('active');
      } else {
        this.els.zoomBtn.textContent = 'Zoom Loop';
        this.els.zoomBtn.classList.remove('active');
      }
    }

    // ── Beat Snap ──

    _snapToBeat(sec) {
      if (!this.beatGridVisible || !this.beatGrid || !this.beatGrid.beats.length) return sec;
      const beats = this.beatGrid.beats;
      let closest = beats[0];
      let minDist = Math.abs(sec - closest);
      for (let i = 1; i < beats.length; i++) {
        const dist = Math.abs(sec - beats[i]);
        if (dist < minDist) { minDist = dist; closest = beats[i]; }
        // Beats are sorted, so once we start getting further away, stop
        if (beats[i] > sec + minDist) break;
      }
      return closest;
    }

    _snapFracToBeat(frac) {
      if (!this.beatGridVisible || !this.beatGrid || !this.duration) return frac;
      const sec = frac * this.duration;
      const snapped = this._snapToBeat(sec);
      return snapped / this.duration;
    }

    // ── Handle Dragging ──

    _startHandleDrag(which, e) {
      if (this.opts.restrictRegion) {
        this._showFrozenToast();
        return;
      }
      e.preventDefault();
      this.draggingHandle = which;
      const el = (which === 'left') ? this.els.handleLeft : this.els.handleRight;
      el.classList.add('dragging');
      document.addEventListener('mousemove', this._onHandleDrag);
      document.addEventListener('mouseup', this._onHandleDragEnd);
      document.addEventListener('touchmove', this._onHandleDrag, { passive: false });
      document.addEventListener('touchend', this._onHandleDragEnd);
    }

    _handleDrag(e) {
      if (!this.draggingHandle) return;
      e.preventDefault();
      const wrapper = this.els.tracksWrapper;
      const rect = wrapper.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const viewFrac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      let frac = this._fromViewFrac(viewFrac);

      // Snap to beat grid if active
      frac = this._snapFracToBeat(frac);

      const minGap = 0.02;

      if (this.draggingHandle === 'left') {
        this.loopStart = Math.max(0, Math.min(frac, this.loopEnd - minGap));
      } else {
        this.loopEnd = Math.min(1, Math.max(frac, this.loopStart + minGap));
      }

      this.loopStartSec = this.loopStart * this.duration;
      this.loopEndSec = this.loopEnd * this.duration;
      this.setLoopRegion(this.loopStartSec, this.loopEndSec);
      this._updateLoopRegion();
    }

    _handleDragEnd() {
      if (this.draggingHandle) {
        const el = (this.draggingHandle === 'left') ? this.els.handleLeft : this.els.handleRight;
        el.classList.remove('dragging');
      }
      this.draggingHandle = null;
      document.removeEventListener('mousemove', this._onHandleDrag);
      document.removeEventListener('mouseup', this._onHandleDragEnd);
      document.removeEventListener('touchmove', this._onHandleDrag);
      document.removeEventListener('touchend', this._onHandleDragEnd);
    }

    _showFrozenToast() {
      this.els.frozenToast.classList.add('visible');
      clearTimeout(this.frozenToastTimer);
      this.frozenToastTimer = setTimeout(() => {
        this.els.frozenToast.classList.remove('visible');
      }, 2000);
    }

    // ── Analysis Toggles ──

    _toggleBeatGrid() {
      this.beatGridVisible = !this.beatGridVisible;
      if (this.els.gridBtn) this.els.gridBtn.classList.toggle('active', this.beatGridVisible);
      this._redrawWaveforms();
    }

    _toggleDriftMap() {
      this._setDriftMapVisible(!this.driftMapVisible);
    }

    _setDriftMapVisible(visible) {
      this.driftMapVisible = visible;
      this.els.driftBtn.classList.toggle('active', visible);
      this._redrawWaveforms();
    }

    // ── Event Handlers ──

    _handleKeydown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        this._togglePlay();
      } else if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && !this.isSingleTrack) {
        e.preventDefault();
        this.switchTrack(this.activeTrack === 'A' ? 'B' : 'A');
      } else if (e.code === 'KeyM' && this.opts.features.markers) {
        // Drop marker at current playhead position
        if (this.isPlaying && this.lastPlayheadSec > 0) {
          this._pinMarker(this.lastPlayheadSec);
        }
      } else if (e.code === 'Escape' && this.isZoomed) {
        e.preventDefault();
        this._unzoom();
      }
    }

    _handleResize() {
      this._updateLoopRegion();
    }

    _togglePlay() {
      if (this.isPlaying) {
        this.stop();
      } else {
        if (!this.bufferA && !this.bufferB) return;
        // Resume from last position if we have one
        const offset = (this.lastPlayheadSec > this.loopStartSec && this.lastPlayheadSec < this.loopEndSec)
          ? this.lastPlayheadSec : undefined;
        this.play(offset);
      }
    }

    // ── DOM Rendering ──

    _render() {
      const f = this.opts.features;

      this.container.innerHTML = '';
      this.container.classList.add('comp-console');

      // Build HTML
      let html = '';

      // Loading overlay
      html += '<div class="comp-loading" data-el="loading">';
      html += '<div class="comp-loading-inner">';
      html += '<div class="comp-loading-text" data-el="loadingText">Analyzing audio<span class="dot-anim"></span></div>';
      html += '<div class="comp-loading-bar" data-el="loadingBar"><div class="comp-loading-fill" data-el="loadingFill"></div></div>';
      html += '</div>';
      html += '</div>';

      // Track identifier header (optional — shows when heading, title, or labels are provided)
      const labelA = this.opts.trackA ? this.opts.trackA.label : '';
      const labelB = this.opts.trackB ? this.opts.trackB.label : '';
      const hasMeta = this.opts.meta && this.opts.meta.length > 0;
      const hasHeader = this.opts.title || labelA || labelB || hasMeta;
      if (hasHeader) {
        html += '<div class="comp-header">';
        // Track A row
        if (this.opts.title || labelA) {
          html += '<div class="comp-track-id">';
          html += '<span class="comp-track-id-badge badge-a">A</span>';
          html += `<span class="comp-track-id-label">${this.opts.title ? this.opts.title.toUpperCase() : ''}${labelA ? ' (' + labelA + ')' : ''}</span>`;
          html += '</div>';
        }
        // Track B row — with meta on the right
        if (this.opts.title || labelB) {
          html += '<div class="comp-track-id comp-track-id-meta">';
          html += '<span class="comp-track-id-badge badge-b">B</span>';
          html += `<span class="comp-track-id-label">${this.opts.title ? this.opts.title.toUpperCase() : ''}${labelB ? ' (' + labelB + ')' : ''}</span>`;
          if (hasMeta) {
            html += '<div class="comp-meta">';
            html += this.opts.meta.map(s => `<span>${s}</span>`).join('<span class="comp-meta-dot">·</span>');
            html += '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }

      // Controls row
      html += '<div class="comp-controls">';
      html += `<button class="comp-play-btn" data-el="playBtn">${PLAY_SVG}</button>`;
      html += `<div class="comp-ab-toggle"${this.isSingleTrack ? ' style="display:none"' : ''}>`;
      html += `<button class="comp-ab-btn${this.activeTrack === 'A' ? ' active-a' : ''}" data-el="abBtnA">A</button>`;
      html += `<button class="comp-ab-btn${this.activeTrack === 'B' ? ' active-b' : ''}" data-el="abBtnB">B</button>`;
      html += '</div>';
      if (!this.isSingleTrack) {
        html += `<div class="comp-switch-hint">or <kbd>${ARROW_SVG}</kbd> to switch</div>`;
      }

      // Zoom button
      html += '<button class="comp-at-btn comp-zoom-btn" data-el="zoomBtn" title="Zoom to loop region">Zoom Loop</button>';

      if (f.driftMap) {
        html += '<button class="comp-at-btn comp-drift-btn" data-el="driftBtn" title="Display track differences">Drift Map</button>';
      }

      html += '<div class="comp-time" data-el="time">0:00 / 0:00</div>';
      html += '</div>';

      // Tracks area
      html += '<div class="comp-tracks-area">';

      // Badge column (hidden in single-track mode)
      html += `<div class="comp-badge-column"${this.isSingleTrack ? ' style="display:none"' : ''}>`;
      html += '<div class="comp-badge-spacer"></div>';
      html += `<div class="comp-track-badge${this.activeTrack === 'A' ? ' active-a' : ''}" data-el="badgeA">A</div>`;
      html += `<div class="comp-track-badge${this.activeTrack === 'B' ? ' active-b' : ''}" data-el="badgeB">B</div>`;
      html += '</div>';

      // Tracks wrapper
      html += '<div class="comp-tracks-wrapper" data-el="tracksWrapper">';

      // Marker rail
      if (f.markers) {
        html += '<div class="comp-marker-rail" data-el="markerRail"></div>';
      }

      // Handle rail
      html += '<div class="comp-handle-rail">';
      html += `<div class="comp-loop-handle" data-el="handleLeft" data-handle="left">${HANDLE_SVG}<div class="comp-handle-line" data-el="handleLineLeft"></div></div>`;
      html += `<div class="comp-loop-handle" data-el="handleRight" data-handle="right">${HANDLE_SVG}<div class="comp-handle-line" data-el="handleLineRight"></div></div>`;
      html += '</div>';

      // Tracks
      html += '<div class="comp-tracks" data-el="tracks">';
      html += '<div class="comp-track"><div class="comp-waveform-container" data-track="A">';
      html += '<canvas class="comp-waveform-canvas" data-el="canvasA"></canvas>';
      html += '<div class="comp-dim-overlay comp-dim-left" data-el="dimLeftA"></div>';
      html += '<div class="comp-dim-overlay comp-dim-right" data-el="dimRightA"></div>';
      html += '<div class="comp-playhead" data-el="playheadA"></div>';
      html += '</div></div>';
      html += `<div class="comp-track"${this.isSingleTrack ? ' style="display:none"' : ''}><div class="comp-waveform-container" data-track="B">`;
      html += '<canvas class="comp-waveform-canvas" data-el="canvasB"></canvas>';
      html += '<div class="comp-dim-overlay comp-dim-left" data-el="dimLeftB"></div>';
      html += '<div class="comp-dim-overlay comp-dim-right" data-el="dimRightB"></div>';
      html += '<div class="comp-playhead" data-el="playheadB"></div>';
      html += '</div></div>';
      html += '</div>'; // .comp-tracks

      // Timeline
      html += '<div class="comp-timeline">';
      html += '<span data-el="timeStart">0:00</span>';
      html += '<span data-el="loopStartTime"></span>';
      html += '<span data-el="loopEndTime"></span>';
      html += '<span data-el="timeEnd">0:00</span>';
      html += '</div>';

      html += '</div>'; // .comp-tracks-wrapper
      html += '</div>'; // .comp-tracks-area

      // Keyboard hint
      html += '<div class="comp-keyboard-hint">';
      html += '<kbd>Space</kbd> play/pause';
      if (!this.isSingleTrack) {
        html += '<span class="comp-hint-sep">\u00B7</span>';
        html += `<kbd>${ARROW_SVG}</kbd> flip tracks`;
      }
      if (f.markers) {
        html += '<span class="comp-hint-sep">\u00B7</span>';
        html += '<kbd>M</kbd> drop marker';
      }
      html += '<span class="comp-hint-sep">\u00B7</span>';
      html += '<kbd>Esc</kbd> unzoom';
      html += '</div>';

      // Frozen toast
      html += '<div class="comp-frozen-toast" data-el="frozenToast">Loop region is locked</div>';

      this.container.innerHTML = html;

      // Cache element references
      this.els = {};
      this.container.querySelectorAll('[data-el]').forEach(el => {
        this.els[el.dataset.el] = el;
      });

      // Draw placeholder waveforms
      this._drawRandomWaveform(this.els.canvasA, 'A');
      if (!this.isSingleTrack) this._drawRandomWaveform(this.els.canvasB, 'B');
    }

    _bindEvents() {
      // Play button
      this.els.playBtn.addEventListener('click', () => this._togglePlay());

      // A/B buttons
      this.els.abBtnA.addEventListener('click', () => this.switchTrack('A'));
      this.els.abBtnB.addEventListener('click', () => this.switchTrack('B'));

      // Badge clicks
      this.els.badgeA.addEventListener('click', () => this.switchTrack('A'));
      this.els.badgeB.addEventListener('click', () => this.switchTrack('B'));

      // Waveform click/scrub
      const waveformContainers = this.container.querySelectorAll('.comp-waveform-container');
      waveformContainers.forEach(wc => {
        if (this.opts.features.scrubbing) {
          wc.addEventListener('mousedown', (e) => this._startScrub(e, wc));
          wc.addEventListener('touchstart', (e) => this._startScrub(e, wc), { passive: false });
        } else {
          wc.addEventListener('click', (e) => {
            const rect = wc.getBoundingClientRect();
            const viewFrac = (e.clientX - rect.left) / rect.width;
            this.seekTo(this._fromViewFrac(viewFrac));
          });
        }

        // Drift-click-to-zoom: click a diff region in Drift Map mode to zoom in
        wc.addEventListener('dblclick', (e) => {
          if (!this.driftMapVisible || !this.diffData) return;
          const rect = wc.getBoundingClientRect();
          const viewFrac = (e.clientX - rect.left) / rect.width;
          this._zoomToDiffRegion(viewFrac);
        });
      });

      // Loop handles
      const bindHandle = (which) => {
        const el = (which === 'left') ? this.els.handleLeft : this.els.handleRight;
        el.addEventListener('mousedown', (e) => this._startHandleDrag(which, e));
        el.addEventListener('touchstart', (e) => this._startHandleDrag(which, e), { passive: false });
      };
      bindHandle('left');
      bindHandle('right');

      // Zoom button
      if (this.els.zoomBtn) {
        this.els.zoomBtn.addEventListener('click', () => this._zoomToLoop());
      }

      // Drift Map toggle
      if (this.els.driftBtn) {
        this.els.driftBtn.addEventListener('click', () => this._toggleDriftMap());
      }

      // Keyboard
      document.addEventListener('keydown', this._onKeydown);

      // Resize
      window.addEventListener('resize', this._onResize);
    }

    // ── Public API ──

    destroy() {
      this.stop();
      this._stopScrubAudio();
      document.removeEventListener('keydown', this._onKeydown);
      window.removeEventListener('resize', this._onResize);
      document.removeEventListener('mousemove', this._onScrubMove);
      document.removeEventListener('mouseup', this._onScrubEnd);
      document.removeEventListener('mousemove', this._onHandleDrag);
      document.removeEventListener('mouseup', this._onHandleDragEnd);
      if (this.ctx) { this.ctx.close().catch(() => {}); }
      this.container.innerHTML = '';
      this.container.classList.remove('comp-console');
    }

    getState() {
      return {
        activeTrack: this.activeTrack,
        loopStart: this.loopStart,
        loopEnd: this.loopEnd,
        isZoomed: this.isZoomed,
        zoomStart: this.zoomStart,
        zoomEnd: this.zoomEnd,
        beatGridVisible: this.beatGridVisible,
        driftMapVisible: this.driftMapVisible,
        markers: this.markers.map(m => m.sec),
        lastPlayheadSec: this.lastPlayheadSec,
      };
    }
  }


  // ══════════════════════════════════════════════════
  //  Public API
  // ══════════════════════════════════════════════════

  return {
    mount(container, opts) {
      return new CompInstance(container, opts);
    }
  };

})();

// Support both module and script-tag usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CompConsole;
}
