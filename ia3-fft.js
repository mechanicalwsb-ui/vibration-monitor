/* ia3-fft.js - i-ALERT3 (vibration, non-OHS) alarm FFT/TWF record decoder.
 * Faithful port of the vendor Android app's decoding path:
 *   com.itt.ialert.sensor.model.ITTiAlert3FFTTWFRecord (record split / offsets / parse)
 *   UnitsManager.getGFFTFromRawData / getVFFTFromGFFTData / getGTWFFromRawData
 *   ITTFFTOption, ITTFFTFrequencyRange, ITTiAlert3VibrationM4Status, ITTiAlert3M4Status,
 *   ITTDigitalAccelerometerRangeOption, ITTiAlert3Bandwidth, ITTiAlert3DeviceStatus
 * Plain browser script, no dependencies. Defines global IA3FFT.
 *
 * NOTE: UnitsManager.result1..result4 are NOT used for i-ALERT3. They feed
 * performFFTCorrection / performTWFCorrection, which are only called from
 * ITTFFTRecord / ITTTWFRecord (i-ALERT2). They are therefore not embedded here.
 */
(function (global) {
  'use strict';

  var TWO_PI = 6.283185307179586;   // literal used in UnitsManager
  var G_IN_PER_S2 = 386.22;         // UnitsManager.getVFFTFromGFFTData literal (1 g in in/s^2)
  var MM_PER_IN = 25.4;
  var f32 = Math.fround;            // Java (float) cast

  // ITTiAlert3FFTTWFRecord constants
  var BLOCK = 8192, LOW_PER_AXIS = 3200, HIGH_PER_AXIS = 4992;
  var TS_INITIAL = 49152, STATUS_INITIAL = 49156, M4_INITIAL = 49158;

  // UnitsManager static scales (iALERT3_VERSION "V1" == "V2"), used when range option is null (analog, devType 8)
  var IA3_GFFT_SCALE = 5480.0, IA3_GTWF_SCALE = 1370.0;

  // ITTDigitalAccelerometerRangeOption(int) constructor table: id -> {rangeInG, fftScale, twfScale, rmsScale}
  var DIGITAL_RANGE = [
    { id: 0, rangeInG: 2,  fftScale: 34640.0, twfScale: 16064.0, rmsScale: 1289.0 },
    { id: 1, rangeInG: 4,  fftScale: 17320.0, twfScale: 8032.0,  rmsScale: 1289.0 },
    { id: 2, rangeInG: 8,  fftScale: 8660.0,  twfScale: 4016.0,  rmsScale: 1289.0 },
    { id: 3, rangeInG: 16, fftScale: 4330.0,  twfScale: 2008.0,  rmsScale: 1289.0 }
  ];

  // ITTFFTOption static table (vibration entries). from/to are FrequencyRange(from,to); x=y=z.
  // twfSampleDurationInSeconds equals the values hardcoded in ITTiAlert3FFTTWFRecord.getTWFSampleDurationInSeconds.
  var FFT_OPTIONS = {
    low: [
      { id: 0, from: 1.0,   to: 1599.0,   hzPerBin: 1.0,   twfSec: 0.1953125 },
      { id: 1, from: 0.5,   to: 799.5,    hzPerBin: 0.5,   twfSec: 0.390625 },
      { id: 2, from: 0.25,  to: 399.75,   hzPerBin: 0.25,  twfSec: 0.78125 },
      { id: 3, from: 0.125, to: 199.875,  hzPerBin: 0.125, twfSec: 1.5625 }
    ],
    high: [
      { id: 0, from: 2.0, to: 4990.0, hzPerBin: 2.0, twfSec: 0.15234375 },
      { id: 1, from: 1.0, to: 2495.0, hzPerBin: 1.0, twfSec: 0.3046875 },
      { id: 2, from: 0.5, to: 1247.5, hzPerBin: 0.5, twfSec: 0.609375 }
      // id 3: no entry -> getFftOptionByFftOptionTypeAndId returns null (app would NPE in getFFTBinSize)
    ]
  };

  // ITTFFTFrequencyRange.getStartBinForX / getEndBinForX / getNumberOfBinsForX ((int) truncation)
  function optionInfo(opt) {
    if (!opt) return null;
    return {
      id: opt.id, hzPerBin: opt.hzPerBin, startFreq: opt.from, endFreq: opt.to,
      startBin: Math.trunc(opt.from / opt.hzPerBin),
      endBin: Math.trunc(opt.to / opt.hzPerBin),
      numBins: Math.trunc((opt.to - opt.from) / opt.hzPerBin + 1.0),
      twfSampleDurationSec: opt.twfSec
    };
  }
  function findOption(list, id) { // ITTFFTOption.getFftOptionByFftOptionTypeAndId
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // ParserHelper.isBitSet / twoBitsToInteger
  function bit(v, i) { return (v & (1 << i)) !== 0; }
  function twoBits(v, i) { return (bit(v, i + 1) ? 2 : 0) + (bit(v, i) ? 1 : 0); }

  // ITTLEPacket.getAbstractDeviceType: 8 = iAlert3ITT (analog), 9 = iAlert3ITTDigitalAccelerometer, 25 = OHS
  // ITTiAlert3M4Status.setRawM4Status + ITTiAlert3VibrationM4Status.setVibrationRawM4Status
  function parseM4(raw, devType) {
    var digital = (devType === 9 || devType === 25);
    var m = {
      raw: raw,
      fluxSaturated: bit(raw, 0),
      smartTrendRunDetection: bit(raw, 1),
      highResolutionRunSpeed: bit(raw, 2),
      fluxLowSensitivity: bit(raw, 3),
      overTempCondition: bit(raw, 4),
      digitalAccelerometerRangeOptionId: digital ? twoBits(raw, 5) : null,
      digitalAccelerometerRange: digital ? DIGITAL_RANGE[twoBits(raw, 5)] : null,
      alarmCheckVibeAlarm: digital ? null : bit(raw, 5),
      alarmCheckTempAlarm: digital ? null : bit(raw, 6),
      fluxDisabled: bit(raw, 7),
      autoRunSpeedEnabled: bit(raw, 8),
      lowFftOptionId: twoBits(raw, 10),
      highFftOptionId: twoBits(raw, 12),
      fluxFftOptionId: twoBits(raw, 14)
    };
    m.lowFftOption = optionInfo(findOption(FFT_OPTIONS.low, m.lowFftOptionId));
    m.highFftOption = optionInfo(findOption(FFT_OPTIONS.high, m.highFftOptionId));
    return m;
  }

  // ITTiAlert3DeviceStatus.setStatus
  function parseStatus(raw, rev) {
    return {
      raw: raw,
      inLowBandwidthSettingMode: rev <= 9 ? bit(raw, 0) : null,
      inAlarmMonth: bit(raw, 1), inAlarmWeek: bit(raw, 2), inAlarm2Days: bit(raw, 3),
      timeSyncDone: bit(raw, 4), isBaselineSet: bit(raw, 5), inBatteryAlarm: bit(raw, 6),
      isWiredModeEnabled: bit(raw, 7), isSmartTrendEnabled: bit(raw, 8),
      isEquipmentRunning: bit(raw, 9), inTempAlarm: bit(raw, 10), inTempWarning: bit(raw, 11),
      inBand2Alarm: bit(raw, 12), inBand1Alarm: bit(raw, 13), inVibAlarm: bit(raw, 14), inVibWarning: bit(raw, 15)
    };
  }

  // parseFFTAxisByteValues (uint16 LE) -> UnitsManager.getGFFTFromRawData: (float)(raw / scale)
  function gfftFromBytes(dv, off, nBytes, fftScale) {
    var n = nBytes >> 1, out = new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = f32(dv.getUint16(off + 2 * i, true) / fftScale);
    return out;
  }
  // UnitsManager.getVFFTFromGFFTData: (float)(g * 386.22 / (i * 2pi * binSize))  [in/s]
  // Index 0 divides by zero exactly as in Java (Infinity, or NaN if g==0); the app never displays bin 0.
  function vfftIpsFromG(g, binSize) {
    var out = new Float32Array(g.length);
    for (var i = 0; i < g.length; i++) out[i] = f32((g[i] * G_IN_PER_S2) / ((i * TWO_PI) * binSize));
    return out;
  }
  function toMm(ips) {
    var out = new Float64Array(ips.length);
    for (var i = 0; i < ips.length; i++) out[i] = ips[i] * MM_PER_IN;
    return out;
  }
  // parseTWFAxisByteValues (int16 LE) -> UnitsManager.getGTWFFromRawData: raw / twfScale (double)
  function gtwfFromBytes(dv, off, nBytes, twfScale) {
    var n = nBytes >> 1, out = new Float64Array(n);
    for (var i = 0; i < n; i++) out[i] = dv.getInt16(off + 2 * i, true) / twfScale;
    return out;
  }

  // One logical record. axisOff = {twfX, fftX, twfY, fftY, twfZ, fftZ}; perAxis = bytes per block.
  function buildBand(dv, axisOff, perAxis, binSize, opt, m4, extra) {
    var r = m4.digitalAccelerometerRange;
    var fftScale = r ? r.fftScale : IA3_GFFT_SCALE;   // getGFFTFromRawData
    var twfScale = r ? r.twfScale : IA3_GTWF_SCALE;   // getGTWFFromRawData
    var gx = gfftFromBytes(dv, axisOff.fftX, perAxis, fftScale);
    var gy = gfftFromBytes(dv, axisOff.fftY, perAxis, fftScale);
    var gz = gfftFromBytes(dv, axisOff.fftZ, perAxis, fftScale);
    var band = {
      fftOptionId: opt ? opt.id : null,
      hzPerBin: binSize,
      startBin: opt ? opt.startBin : null,
      endBin: opt ? opt.endBin : null,
      startFreq: opt ? opt.startFreq : null,
      endFreq: opt ? opt.endFreq : null,
      fftScale: fftScale, twfScale: twfScale,
      gfft: { x: gx, y: gy, z: gz },
      vfft: null, vfftIps: null,
      twf: {
        x: gtwfFromBytes(dv, axisOff.twfX, perAxis, twfScale),
        y: gtwfFromBytes(dv, axisOff.twfY, perAxis, twfScale),
        z: gtwfFromBytes(dv, axisOff.twfZ, perAxis, twfScale)
      }
    };
    if (binSize != null) {
      var vx = vfftIpsFromG(gx, binSize), vy = vfftIpsFromG(gy, binSize), vz = vfftIpsFromG(gz, binSize);
      band.vfftIps = { x: vx, y: vy, z: vz };
      band.vfft = { x: toMm(vx), y: toMm(vy), z: toMm(vz) };
    }
    for (var k in extra) band[k] = extra[k];
    band.twfSamples = band.twf.x.length;
    band.twfSampleRate = band.sampleDurationSec ? band.twfSamples / band.sampleDurationSec : null;
    // Frequency of array index k is k*hzPerBin (iAlert3FFTTWFRecord.getCombinedData: startFreq + i*bin over subList(startBin..endBin)).
    if (binSize != null) {
      var f = new Float64Array(gx.length);
      for (var i = 0; i < f.length; i++) f[i] = i * binSize;
      band.freq = f;
    }
    return band;
  }

  /**
   * decodeAlarmRecord(bytes, {rev, devType})
   * bytes: Uint8Array of the record AFTER the bulk header (49380 bytes for rev>=10, 49160 for rev<=9).
   * devType: 8 = analog i-ALERT3, 9 = digital-accelerometer i-ALERT3 (default 9).
   */
  function decodeAlarmRecord(bytes, opts) {
    opts = opts || {};
    var rev = opts.rev != null ? opts.rev : 10;
    var devType = opts.devType != null ? opts.devType : 9;
    var expected = rev <= 9 ? 49160 : 49380; // ITTiAlert3FFTTWFRecord.recordLength (non-OHS)
    if (!bytes || bytes.length < expected) throw new Error('IA3FFT: record too short: ' + (bytes && bytes.length) + ' < ' + expected);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Timestamp/status/M4 are at the same absolute offsets in the original record for all revs
    // (after split they move to 6*perAxis, which maps back to 49152/49156/49158).
    var ts = dv.getUint32(TS_INITIAL, true);
    var statusRaw = dv.getUint16(STATUS_INITIAL, true);
    var m4Raw = dv.getUint16(M4_INITIAL, true);
    var m4 = parseM4(m4Raw, devType);
    var status = parseStatus(statusRaw, rev);
    var res = {
      rev: rev, devType: devType,
      valid: !(ts === 0xFFFFFFFF || ts === 0), // ITTiAlert3FFTTWFRecord.areDataValid
      timestamp: ts, status: status, m4: m4,
      digitalAccelerometerRangeOption: m4.digitalAccelerometerRange,
      low: null, high: null, single: null,
      systemStructure: rev >= 10 ? bytes.subarray(49160, 49380) : null // 220 bytes, not decoded here
    };

    if (rev <= 9) {
      // recordWithData: no split; fixed 8192-byte blocks; bandwidth from status bit 0
      // (ITTiAlert3Bandwidth.getBandwidthFromLowBandwidthSettingMode: LOW -> 1 Hz/bin, 0.5 s; HIGH -> 2 Hz/bin, 0.25 s).
      // getFftOption() is null here (ordering never set), so start/end bin/freq are null in the app.
      var low = status.inLowBandwidthSettingMode;
      res.single = buildBand(dv,
        { twfX: 0, fftX: 8192, twfY: 16384, fftY: 24576, twfZ: 32768, fftZ: 40960 },
        BLOCK, low ? 1 : 2, null, m4,
        { ordering: 0, timestamp: ts, bandwidth: low ? 'LOW' : 'HIGH', sampleDurationSec: low ? 0.5 : 0.25 });
      return res;
    }

    // rev >= 10: recordWithData splits into ordering 1 (bytes 0..3200 of each 8192 block)
    // and ordering 2 (bytes 3200..8192 of each block). Reading directly from the original
    // blocks is byte-identical to the app's System.arraycopy + setAppropriatePositions.
    var lowOpt = m4.lowFftOption, highOpt = m4.highFftOption;
    res.low = buildBand(dv,
      { twfX: 0, fftX: 8192, twfY: 16384, fftY: 24576, twfZ: 32768, fftZ: 40960 },
      LOW_PER_AXIS, lowOpt ? lowOpt.hzPerBin : null, lowOpt, m4,
      { ordering: 1, timestamp: ts, bandwidth: 'LOW', sampleDurationSec: lowOpt ? lowOpt.twfSampleDurationSec : null });
    res.high = buildBand(dv,
      { twfX: 3200, fftX: 8192 + 3200, twfY: 16384 + 3200, fftY: 24576 + 3200, twfZ: 32768 + 3200, fftZ: 40960 + 3200 },
      HIGH_PER_AXIS, highOpt ? highOpt.hzPerBin : null, highOpt, m4,
      { ordering: 2, timestamp: ts + 1, bandwidth: 'HIGH', sampleDurationSec: highOpt ? highOpt.twfSampleDurationSec : null });
    return res;
  }

  /**
   * combine(low, high, key, axis) - port of charilaolaliotis iAlert3FFTTWFRecord.getCombinedData:
   * low.subList(startBin..endBin) then high bins from ceil((lowEnd - highStart)/highBin), skipping an exact duplicate.
   * key: 'vfft' | 'vfftIps' | 'gfft'. Returns {freq:[], val:[]}.
   */
  function combine(low, high, key, axis) {
    var freq = [], val = [];
    var a = low[key][axis];
    for (var i = low.startBin; i <= low.endBin; i++) { freq.push(low.startFreq + (i - low.startBin) * low.hzPerBin); val.push(a[i]); }
    if (high && high.startBin != null) {
      var b = high[key][axis].slice(high.startBin, high.endBin + 1);
      var end = low.endFreq;
      var c = Math.ceil((end - high.startFreq) / high.hzPerBin);
      var f2 = high.startFreq + c * high.hzPerBin;
      if (f2 <= high.endFreq) {
        if (f2 === end) c++;
        for (var j = c; j < b.length; j++) { freq.push(high.startFreq + j * high.hzPerBin); val.push(b[j]); }
      }
    }
    return { freq: freq, val: val };
  }

  global.IA3FFT = {
    decodeAlarmRecord: decodeAlarmRecord,
    combine: combine,
    parseM4Status: parseM4,
    parseDeviceStatus: parseStatus,
    FFT_OPTIONS: FFT_OPTIONS,
    DIGITAL_RANGE: DIGITAL_RANGE,
    ANALOG_SCALES: { gfft: IA3_GFFT_SCALE, gtwf: IA3_GTWF_SCALE },
    optionInfo: optionInfo
  };
})(typeof window !== 'undefined' ? window : globalThis);
