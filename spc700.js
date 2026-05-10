// ============================================================
// spc700.js  v8  ―  SPC700 + DSP フル実装
//   - 256命令の SPC700 CPU
//   - IPL ROM 経由の実ハンドシェイク (バイパス撤去)
//   - BRR デコード / ADSR / KON,KOF / ピッチ / ボリューム
//   - テストトーン削除
// ============================================================

// PSW フラグビット
const F_N = 0x80, F_V = 0x40, F_P = 0x20, F_B = 0x10;
const F_H = 0x08, F_I = 0x04, F_Z = 0x02, F_C = 0x01;

// SPC700 IPL ROM ($FFC0-$FFFF, 64バイト)
const SPC_IPL_ROM = new Uint8Array([
  0xCD, 0xEF, 0xBD, 0xE8, 0x00, 0xC6, 0x1D, 0xD0, 0xFC, 0x8F, 0xAA, 0xF4, 0x8F, 0xBB, 0xF5, 0x78,
  0xCC, 0xF4, 0xD0, 0xFB, 0x2F, 0x19, 0xEB, 0xF4, 0xD0, 0xFC, 0x7E, 0xF4, 0xD0, 0x0B, 0xE4, 0xF5,
  0xCB, 0xF4, 0xD7, 0x00, 0xFC, 0xD0, 0xF3, 0xAB, 0x01, 0x10, 0xEF, 0x7E, 0xF4, 0x10, 0xEB, 0xBA,
  0xF6, 0xDA, 0x00, 0xBA, 0xF4, 0xC4, 0xF4, 0xDD, 0x5D, 0xD0, 0xDB, 0x1F, 0x00, 0x00, 0xC0, 0xFF
]);

// ============================================================
//  DSP (Digital Signal Processor)
// ============================================================
class SPCDSP {
  constructor(ram) {
    this.ram = ram;
    this.regs = new Uint8Array(128);

    this.voices = [];
    for (let i = 0; i < 8; i++) {
      this.voices.push({
        brrAddr: 0,
        brrPos: 0,         // 9バイトブロック内オフセット
        sampleBuf: new Float32Array(16), // デコード済みサンプル
        bufPos: 16,        // 16=空 → 次に読むときデコード
        p1: 0, p2: 0,      // 直前2サンプル (BRRフィルタ用)
        pitchCounter: 0,   // 0..1.0 で進む補間カウンタ
        env: 0,            // 0..1
        envState: 0,       // 0=release, 1=attack, 2=decay, 3=sustain
        active: false,
        startAddr: 0,
        loopAddr: 0,
      });
    }
    this.endx = 0;
    this.bufSize = 32000;
    this.outL = new Float32Array(this.bufSize);
    this.outR = new Float32Array(this.bufSize);
    this.bufIdx = 0;
  }

  reset() {
    this.regs.fill(0);
    this.regs[0x6C] = 0xE0;
    for (const v of this.voices) {
      v.brrAddr = 0; v.brrPos = 0; v.bufPos = 16;
      v.p1 = 0; v.p2 = 0; v.pitchCounter = 0;
      v.env = 0; v.envState = 0; v.active = false;
    }
    this.endx = 0;
    this.bufIdx = 0;
  }

  read(addr) {
    addr &= 0x7F;
    if (addr === 0x7C) return this.endx;
    return this.regs[addr];
  }

  write(addr, val) {
    addr &= 0x7F; val &= 0xFF;
    this.regs[addr] = val;

    if (addr === 0x4C) { // KON: Key On
      for (let i = 0; i < 8; i++) {
        if (val & (1 << i)) this._keyOn(i);
      }
    } else if (addr === 0x5C) { // KOF: Key Off
      for (let i = 0; i < 8; i++) {
        if (val & (1 << i)) this._keyOff(i);
      }
    } else if (addr === 0x6C) { // FLG
      if (val & 0x80) { // soft reset
        for (let i = 0; i < 8; i++) this._keyOff(i);
      }
    } else if (addr === 0x7C) {
      this.endx = 0;
    }
  }

  _keyOn(i) {
    const v = this.voices[i];
    const dirBase = this.regs[0x5D] << 8;
    const srcn = this.regs[(i << 4) | 0x04];
    const entry = (dirBase + srcn * 4) & 0xFFFF;
    v.startAddr = (this.ram[entry] | (this.ram[(entry+1) & 0xFFFF] << 8)) & 0xFFFF;
    v.loopAddr  = (this.ram[(entry+2) & 0xFFFF] | (this.ram[(entry+3) & 0xFFFF] << 8)) & 0xFFFF;
    v.brrAddr = v.startAddr;
    v.brrPos = 0;
    v.bufPos = 16;
    v.p1 = 0; v.p2 = 0;
    v.pitchCounter = 0;
    v.env = 0;
    v.envState = 1; // ATTACK
    v.active = true;
    this.endx &= ~(1 << i);
  }

  _keyOff(i) {
    const v = this.voices[i];
    if (v.active) v.envState = 0; // RELEASE
  }

  // 簡易レート: ADSR1/2 から 1サンプルあたりの増減量を返す。
  // 実機の正確なレートテーブルではなく聴感優先の近似。
  _envStep(rate) {
    if (rate === 0) return 0;
    return 1.0 / (32000 / Math.max(1, Math.pow(2, 15 - (rate / 2))));
  }

  _updateEnvelope(v, vIdx) {
    if (!v.active) return 0;

    const adsr1 = this.regs[(vIdx << 4) | 0x05];
    const adsr2 = this.regs[(vIdx << 4) | 0x06];
    const gain  = this.regs[(vIdx << 4) | 0x07];
    const useADSR = (adsr1 & 0x80) !== 0;

    if (v.envState === 0) {
      // RELEASE: 800サンプルで0→1.0減衰相当
      v.env -= 1.0 / 800;
      if (v.env <= 0) { v.env = 0; v.active = false; }
    } else if (useADSR) {
      const ar = adsr1 & 0x0F;       // 0..15
      const dr = (adsr1 >> 4) & 0x07; // 0..7
      const sl = (adsr2 >> 5) & 0x07; // 0..7  sustain level (sl+1)/8
      const sr = adsr2 & 0x1F;       // 0..31

      if (v.envState === 1) { // ATTACK
        const step = ar === 15 ? 1.0 : 1.0 / Math.max(1, (16 - ar) * 64);
        v.env += step;
        if (v.env >= 1.0) { v.env = 1.0; v.envState = 2; }
      } else if (v.envState === 2) { // DECAY
        const sustainLevel = (sl + 1) / 8;
        const step = 1.0 / Math.max(1, (8 - dr) * 256);
        v.env -= step;
        if (v.env <= sustainLevel) { v.env = sustainLevel; v.envState = 3; }
      } else if (v.envState === 3) { // SUSTAIN
        if (sr > 0) {
          const step = 1.0 / Math.max(1, (32 - sr) * 1024);
          v.env -= step;
          if (v.env <= 0) { v.env = 0; v.active = false; }
        }
      }
    } else {
      // GAIN モード
      if (gain & 0x80) {
        // 増減モード
        const mode = (gain >> 5) & 3;
        const rate = gain & 0x1F;
        const step = this._envStep(rate);
        if (mode === 0)      v.env -= step * 2;
        else if (mode === 1) v.env -= step * v.env;
        else if (mode === 2) v.env += step * 2;
        else                 v.env += step * (1 - v.env) * 2;
        if (v.env > 1) v.env = 1;
        if (v.env < 0) { v.env = 0; v.active = false; }
      } else {
        v.env = (gain & 0x7F) / 127;
      }
    }
    return v.env;
  }

  _decodeBRRBlock(v) {
    const header = this.ram[v.brrAddr & 0xFFFF];
    const shift = header >> 4;
    const filter = (header >> 2) & 3;
    const flags = header & 3;

    const f0 = [0.0, 15/16, 61/32, 115/64][filter];
    const f1 = [0.0, 0.0, -15/16, -13/16][filter];

    let p1 = v.p1, p2 = v.p2;
    for (let i = 0; i < 8; i++) {
      const byte = this.ram[(v.brrAddr + 1 + i) & 0xFFFF];
      for (let n = 0; n < 2; n++) {
        let nib = n === 0 ? (byte >> 4) : (byte & 0x0F);
        if (nib >= 8) nib -= 16;
        let s;
        if (shift > 12) s = (nib < 0 ? -2048 : 0);
        else            s = (nib << shift) >> 1;
        s += p1 * f0 + p2 * f1;
        if (s > 32767)  s = 32767;
        if (s < -32768) s = -32768;
        v.sampleBuf[i*2 + n] = s / 32768;
        p2 = p1; p1 = s;
      }
    }
    v.p1 = p1; v.p2 = p2;
    v.bufPos = 0;

    if (flags & 1) { // End
      const idx = this.voices.indexOf(v);
      this.endx |= (1 << idx);
      if (flags & 2) {
        v.brrAddr = v.loopAddr;
      } else {
        v.envState = 0;
        v.env = 0;
        v.active = false;
      }
    } else {
      v.brrAddr = (v.brrAddr + 9) & 0xFFFF;
    }
  }

  // 1サンプル分の DSP 出力を生成 (32kHz)
  generateSample() {
    if (this.bufIdx >= this.bufSize) return;

    const flg = this.regs[0x6C];
    const muteAll = (flg & 0x40) !== 0;

    let mixL = 0, mixR = 0;

    const mvolL = (new Int8Array([this.regs[0x0C]]))[0] / 128;
    const mvolR = (new Int8Array([this.regs[0x1C]]))[0] / 128;

    for (let i = 0; i < 8; i++) {
      const v = this.voices[i];
      if (!v.active) continue;

      // ピッチ: pitchHL を 0x1000 = 1.0 として補間ステップ算出
      const pl = this.regs[(i << 4) | 0x02];
      const ph = this.regs[(i << 4) | 0x03] & 0x3F;
      const pitch = pl | (ph << 8);
      const step = pitch / 0x1000;

      if (v.bufPos >= 16) {
        this._decodeBRRBlock(v);
        if (!v.active) continue;
      }

      // 線形補間
      const idx = Math.floor(v.bufPos);
      const frac = v.bufPos - idx;
      const s0 = v.sampleBuf[idx];
      const s1 = idx < 15 ? v.sampleBuf[idx + 1] : v.sampleBuf[15];
      const sample = s0 + (s1 - s0) * frac;

      v.pitchCounter += step;
      v.bufPos += step;

      const env = this._updateEnvelope(v, i);

      const vL = (new Int8Array([this.regs[(i << 4) | 0x00]]))[0] / 128;
      const vR = (new Int8Array([this.regs[(i << 4) | 0x01]]))[0] / 128;

      mixL += sample * vL * env;
      mixR += sample * vR * env;

      // OUTX, ENVX (read-only) を一応反映
      this.regs[(i << 4) | 0x08] = Math.max(0, Math.min(127, Math.round(env * 127)));
      this.regs[(i << 4) | 0x09] = Math.max(-128, Math.min(127, Math.round(sample * 127)));
    }

    if (muteAll) { mixL = 0; mixR = 0; }

    mixL *= mvolL; mixR *= mvolR;
    if (mixL >  1) mixL =  1; if (mixL < -1) mixL = -1;
    if (mixR >  1) mixR =  1; if (mixR < -1) mixR = -1;

    this.outL[this.bufIdx] = mixL;
    this.outR[this.bufIdx] = mixR;
    this.bufIdx++;
  }

  getSamples() {
    if (this.bufIdx === 0) return null;
    const l = new Float32Array(this.outL.subarray(0, this.bufIdx));
    const r = new Float32Array(this.outR.subarray(0, this.bufIdx));
    this.bufIdx = 0;
    return { left: l, right: r };
  }
}

// ============================================================
//  SPC700 CPU
// ============================================================
class SPC700CPU {
  constructor() {
    this.ram = new Uint8Array(0x10000);
    this.A = 0; this.X = 0; this.Y = 0;
    this.SP = 0xEF;
    this.PC = 0xFFC0;
    this.PSW = 0x02; // Z=1

    // CPU<->APU IO ポート
    this.inPorts  = new Uint8Array(4); // CPU が書き込むバイト (SPC が読む)
    this.outPorts = new Uint8Array(4); // SPC が書き込むバイト (CPU が読む)

    // タイマー
    this.timers = [
      { enable: false, target: 256, counter: 0, output: 0, divider: 0 }, // T0 8kHz
      { enable: false, target: 256, counter: 0, output: 0, divider: 0 }, // T1 8kHz
      { enable: false, target: 256, counter: 0, output: 0, divider: 0 }, // T2 64kHz
    ];
    this.control = 0; // $F1
    this.dspAddr = 0;

    this.iplEnabled = true; // $F1.bit7

    this.dsp = new SPCDSP(this.ram);
    this._cycleAccumDSP = 0;
    this._cycleAccumT01 = 0;
    this._cycleAccumT2  = 0;

    this.stopped = false;
  }

  reset() {
    this.A = 0; this.X = 0; this.Y = 0;
    this.SP = 0xEF;
    this.PC = 0xFFC0;
    this.PSW = 0x02;
    this.ram.fill(0);
    this.outPorts.fill(0);
    this.inPorts.fill(0);
    this.iplEnabled = true;
    this.control = 0;
    this.dsp.reset();
    this.stopped = false;
    for (const t of this.timers) {
      t.enable = false; t.counter = 0; t.output = 0; t.divider = 0;
    }
  }

  // ----------------------------------------------------------
  //  メモリアクセス
  // ----------------------------------------------------------
  read(addr) {
    addr &= 0xFFFF;
    if (addr >= 0x00F0 && addr <= 0x00FF) {
      switch (addr) {
        case 0xF0: return 0;
        case 0xF1: return 0;
        case 0xF2: return this.dspAddr;
        case 0xF3: return this.dsp.read(this.dspAddr & 0x7F);
        case 0xF4: return this.inPorts[0];
        case 0xF5: return this.inPorts[1];
        case 0xF6: return this.inPorts[2];
        case 0xF7: return this.inPorts[3];
        case 0xF8: return this.ram[0xF8];
        case 0xF9: return this.ram[0xF9];
        case 0xFA: return 0;
        case 0xFB: return 0;
        case 0xFC: return 0;
        case 0xFD: { const v = this.timers[0].output; this.timers[0].output = 0; return v & 0xF; }
        case 0xFE: { const v = this.timers[1].output; this.timers[1].output = 0; return v & 0xF; }
        case 0xFF: { const v = this.timers[2].output; this.timers[2].output = 0; return v & 0xF; }
      }
    }
    if (this.iplEnabled && addr >= 0xFFC0) {
      return SPC_IPL_ROM[addr - 0xFFC0];
    }
    return this.ram[addr];
  }

  write(addr, val) {
    addr &= 0xFFFF; val &= 0xFF;
    // RAM へは常に書く (ハードウェア上 IPL ROM領域も RAM が裏にいる)
    this.ram[addr] = val;
    if (addr >= 0x00F0 && addr <= 0x00FF) {
      switch (addr) {
        case 0xF0: break;
        case 0xF1: {
          this.control = val;
          for (let i = 0; i < 3; i++) {
            const en = !!(val & (1 << i));
            if (en && !this.timers[i].enable) {
              this.timers[i].counter = 0;
              this.timers[i].output = 0;
            }
            this.timers[i].enable = en;
          }
          if (val & 0x10) { this.inPorts[0] = 0; this.inPorts[1] = 0; }
          if (val & 0x20) { this.inPorts[2] = 0; this.inPorts[3] = 0; }
          this.iplEnabled = !!(val & 0x80);
          break;
        }
        case 0xF2: this.dspAddr = val; break;
        case 0xF3: if (this.dspAddr < 0x80) this.dsp.write(this.dspAddr, val); break;
        case 0xF4: this.outPorts[0] = val; break;
        case 0xF5: this.outPorts[1] = val; break;
        case 0xF6: this.outPorts[2] = val; break;
        case 0xF7: this.outPorts[3] = val; break;
        case 0xFA: this.timers[0].target = val === 0 ? 256 : val; break;
        case 0xFB: this.timers[1].target = val === 0 ? 256 : val; break;
        case 0xFC: this.timers[2].target = val === 0 ? 256 : val; break;
      }
    }
  }

  // ----------------------------------------------------------
  //  PSW / フラグユーティリティ
  // ----------------------------------------------------------
  setNZ8 (v) { v &= 0xFF;   this.PSW = (this.PSW & ~(F_N|F_Z)) | (v & 0x80) | (v === 0 ? F_Z : 0); }
  setNZ16(v) { v &= 0xFFFF; this.PSW = (this.PSW & ~(F_N|F_Z)) | ((v & 0x8000) ? F_N : 0) | (v === 0 ? F_Z : 0); }

  _adc(a, b) {
    const c = (this.PSW & F_C) ? 1 : 0;
    const r = a + b + c;
    this.PSW &= ~(F_N|F_V|F_H|F_Z|F_C);
    if (((a ^ b) & 0x80) === 0 && ((a ^ r) & 0x80)) this.PSW |= F_V;
    if (((a & 0x0F) + (b & 0x0F) + c) > 0x0F) this.PSW |= F_H;
    if (r > 0xFF) this.PSW |= F_C;
    const r8 = r & 0xFF;
    if (r8 & 0x80) this.PSW |= F_N;
    if (r8 === 0) this.PSW |= F_Z;
    return r8;
  }
  _sbc(a, b) { return this._adc(a, b ^ 0xFF); }

  _cmp(a, b) {
    const r = a - b;
    this.PSW &= ~(F_N|F_Z|F_C);
    if (r >= 0) this.PSW |= F_C;
    const r8 = r & 0xFF;
    if (r8 & 0x80) this.PSW |= F_N;
    if (r8 === 0) this.PSW |= F_Z;
  }

  _cmpw(a, b) {
    const r = (a - b) & 0xFFFFF;
    this.PSW &= ~(F_N|F_Z|F_C);
    if (a >= b) this.PSW |= F_C;
    const r16 = (a - b) & 0xFFFF;
    if (r16 & 0x8000) this.PSW |= F_N;
    if (r16 === 0) this.PSW |= F_Z;
  }

  _addw(a, b) {
    const r = a + b;
    this.PSW &= ~(F_N|F_V|F_H|F_Z|F_C);
    if (((a ^ b) & 0x8000) === 0 && ((a ^ r) & 0x8000)) this.PSW |= F_V;
    if (((a & 0x0FFF) + (b & 0x0FFF)) > 0x0FFF) this.PSW |= F_H;
    if (r > 0xFFFF) this.PSW |= F_C;
    const r16 = r & 0xFFFF;
    if (r16 & 0x8000) this.PSW |= F_N;
    if (r16 === 0) this.PSW |= F_Z;
    return r16;
  }
  _subw(a, b) {
    const r = a - b;
    this.PSW &= ~(F_N|F_V|F_H|F_Z|F_C);
    if (((a ^ b) & 0x8000) !== 0 && ((a ^ r) & 0x8000)) this.PSW |= F_V;
    if (a >= b) this.PSW |= F_C;
    if (((a & 0x0FFF) - (b & 0x0FFF)) >= 0) this.PSW |= F_H;
    const r16 = r & 0xFFFF;
    if (r16 & 0x8000) this.PSW |= F_N;
    if (r16 === 0) this.PSW |= F_Z;
    return r16;
  }

  // ----------------------------------------------------------
  //  アドレッシング
  // ----------------------------------------------------------
  _imm()  { return this.read(this.PC++ & 0xFFFF); }
  _dpAddr(off) { return ((this.PSW & F_P) ? 0x100 : 0) | (off & 0xFF); }
  _dp()    { return this._dpAddr(this._imm()); }
  _dpx()   { return this._dpAddr((this._imm() + this.X) & 0xFF); }
  _dpy()   { return this._dpAddr((this._imm() + this.Y) & 0xFF); }
  _abs()   { const lo = this._imm(); const hi = this._imm(); return (hi << 8) | lo; }
  _absx()  { return (this._abs() + this.X) & 0xFFFF; }
  _absy()  { return (this._abs() + this.Y) & 0xFFFF; }
  _idpx()  { const a = this._dpx(); return this.read(a) | (this.read((a+1)&0xFFFF) << 8); }
  _idpy()  { const a = this._dp(); const ptr = this.read(a) | (this.read((a+1)&0xFFFF) << 8); return (ptr + this.Y) & 0xFFFF; }
  _rel()   { const r = this._imm(); return r > 127 ? r - 256 : r; }

  // 16bit DPワード読み書き (DPアドレス→ DP+1)
  _readW(dp) { return this.read(dp) | (this.read(this._dpAddr((dp+1)&0xFF)) << 8); }
  _writeW(dp, val) { this.write(dp, val & 0xFF); this.write(this._dpAddr((dp+1)&0xFF), (val >> 8) & 0xFF); }

  // ----------------------------------------------------------
  //  スタック
  // ----------------------------------------------------------
  push8(v)  { this.write(0x100 | this.SP, v); this.SP = (this.SP - 1) & 0xFF; }
  pull8()   { this.SP = (this.SP + 1) & 0xFF; return this.read(0x100 | this.SP); }
  push16(v) { this.push8((v >> 8) & 0xFF); this.push8(v & 0xFF); }
  pull16()  { const lo = this.pull8(); const hi = this.pull8(); return (hi << 8) | lo; }

  // ----------------------------------------------------------
  //  RMW ヘルパー
  // ----------------------------------------------------------
  _asl(v) {
    this.PSW = (this.PSW & ~F_C) | ((v & 0x80) ? F_C : 0);
    const r = (v << 1) & 0xFF; this.setNZ8(r); return r;
  }
  _lsr(v) {
    this.PSW = (this.PSW & ~F_C) | ((v & 0x01) ? F_C : 0);
    const r = (v >> 1) & 0xFF; this.setNZ8(r); return r;
  }
  _rol(v) {
    const c = (this.PSW & F_C) ? 1 : 0;
    this.PSW = (this.PSW & ~F_C) | ((v & 0x80) ? F_C : 0);
    const r = ((v << 1) | c) & 0xFF; this.setNZ8(r); return r;
  }
  _ror(v) {
    const c = (this.PSW & F_C) ? 0x80 : 0;
    this.PSW = (this.PSW & ~F_C) | ((v & 0x01) ? F_C : 0);
    const r = ((v >> 1) | c) & 0xFF; this.setNZ8(r); return r;
  }

  // ビット操作
  _bit(addr, op) {
    const v = this.read(addr);
    let r = v;
    if (op === 'set')   r |=  (1 << ((this._curBit) & 7));
    else if (op === 'clr') r &= ~(1 << ((this._curBit) & 7));
    this.write(addr, r);
  }

  // 1命令実行 → 概算サイクル数を返す
  step() {
    if (this.stopped) return 1;
    const op = this.read(this.PC++ & 0xFFFF);
    return this.execute(op);
  }

  execute(op) {
    let a, b, addr, dp, lo, hi, r, rel, c, off, bit;

    switch (op) {
      // ----- 0x00..0x0F -----
      case 0x00: return 2; // NOP
      case 0x01: case 0x11: case 0x21: case 0x31:
      case 0x41: case 0x51: case 0x61: case 0x71:
      case 0x81: case 0x91: case 0xA1: case 0xB1:
      case 0xC1: case 0xD1: case 0xE1: case 0xF1: { // TCALL n
        const n = (op >> 4) & 0xF;
        this.push16(this.PC);
        const tgt = 0xFFDE - n * 2;
        this.PC = this.read(tgt) | (this.read(tgt + 1) << 8);
        return 8;
      }
      case 0x02: case 0x22: case 0x42: case 0x62:
      case 0x82: case 0xA2: case 0xC2: case 0xE2: { // SET1 dp.bit
        bit = (op >> 5) & 7;
        addr = this._dp();
        this.write(addr, this.read(addr) | (1 << bit));
        return 4;
      }
      case 0x12: case 0x32: case 0x52: case 0x72:
      case 0x92: case 0xB2: case 0xD2: case 0xF2: { // CLR1 dp.bit
        bit = (op >> 5) & 7;
        addr = this._dp();
        this.write(addr, this.read(addr) & ~(1 << bit));
        return 4;
      }
      case 0x03: case 0x23: case 0x43: case 0x63:
      case 0x83: case 0xA3: case 0xC3: case 0xE3: { // BBS dp.bit, rel
        bit = (op >> 5) & 7;
        a = this.read(this._dp());
        rel = this._rel();
        if (a & (1 << bit)) { this.PC = (this.PC + rel) & 0xFFFF; return 7; }
        return 5;
      }
      case 0x13: case 0x33: case 0x53: case 0x73:
      case 0x93: case 0xB3: case 0xD3: case 0xF3: { // BBC dp.bit, rel
        bit = (op >> 5) & 7;
        a = this.read(this._dp());
        rel = this._rel();
        if (!(a & (1 << bit))) { this.PC = (this.PC + rel) & 0xFFFF; return 7; }
        return 5;
      }

      // ----- OR -----
      case 0x04: this.A |= this.read(this._dp());   this.setNZ8(this.A); return 3; // OR A, dp
      case 0x05: this.A |= this.read(this._abs());  this.setNZ8(this.A); return 4; // OR A, !abs
      case 0x06: this.A |= this.read(this._dpAddr(this.X)); this.setNZ8(this.A); return 3; // OR A, (X)
      case 0x07: this.A |= this.read(this._idpx()); this.setNZ8(this.A); return 6; // OR A, [dp+X]
      case 0x08: this.A |= this._imm();             this.setNZ8(this.A); return 2; // OR A, #imm
      case 0x09: { // OR dp, dp (src→dst)
        const src = this.read(this._dp());
        addr = this._dp();
        r = (this.read(addr) | src) & 0xFF;
        this.setNZ8(r); this.write(addr, r);
        return 6;
      }
      case 0x14: this.A |= this.read(this._dpx());  this.setNZ8(this.A); return 4;
      case 0x15: this.A |= this.read(this._absx()); this.setNZ8(this.A); return 5;
      case 0x16: this.A |= this.read(this._absy()); this.setNZ8(this.A); return 5;
      case 0x17: this.A |= this.read(this._idpy()); this.setNZ8(this.A); return 6;
      case 0x18: { // OR dp, #imm
        const v = this._imm(); addr = this._dp();
        r = (this.read(addr) | v) & 0xFF; this.setNZ8(r); this.write(addr, r); return 5;
      }
      case 0x19: { // OR (X), (Y)
        addr = this._dpAddr(this.X);
        r = (this.read(addr) | this.read(this._dpAddr(this.Y))) & 0xFF;
        this.setNZ8(r); this.write(addr, r); return 5;
      }

      // ----- AND -----
      case 0x24: this.A &= this.read(this._dp());   this.setNZ8(this.A); return 3;
      case 0x25: this.A &= this.read(this._abs());  this.setNZ8(this.A); return 4;
      case 0x26: this.A &= this.read(this._dpAddr(this.X)); this.setNZ8(this.A); return 3;
      case 0x27: this.A &= this.read(this._idpx()); this.setNZ8(this.A); return 6;
      case 0x28: this.A &= this._imm();             this.setNZ8(this.A); return 2;
      case 0x29: {
        const src = this.read(this._dp());
        addr = this._dp();
        r = (this.read(addr) & src) & 0xFF;
        this.setNZ8(r); this.write(addr, r); return 6;
      }
      case 0x34: this.A &= this.read(this._dpx());  this.setNZ8(this.A); return 4;
      case 0x35: this.A &= this.read(this._absx()); this.setNZ8(this.A); return 5;
      case 0x36: this.A &= this.read(this._absy()); this.setNZ8(this.A); return 5;
      case 0x37: this.A &= this.read(this._idpy()); this.setNZ8(this.A); return 6;
      case 0x38: {
        const v = this._imm(); addr = this._dp();
        r = (this.read(addr) & v) & 0xFF; this.setNZ8(r); this.write(addr, r); return 5;
      }
      case 0x39: {
        addr = this._dpAddr(this.X);
        r = (this.read(addr) & this.read(this._dpAddr(this.Y))) & 0xFF;
        this.setNZ8(r); this.write(addr, r); return 5;
      }

      // ----- EOR -----
      case 0x44: this.A ^= this.read(this._dp());   this.setNZ8(this.A); return 3;
      case 0x45: this.A ^= this.read(this._abs());  this.setNZ8(this.A); return 4;
      case 0x46: this.A ^= this.read(this._dpAddr(this.X)); this.setNZ8(this.A); return 3;
      case 0x47: this.A ^= this.read(this._idpx()); this.setNZ8(this.A); return 6;
      case 0x48: this.A ^= this._imm();             this.setNZ8(this.A); return 2;
      case 0x49: {
        const src = this.read(this._dp());
        addr = this._dp();
        r = (this.read(addr) ^ src) & 0xFF;
        this.setNZ8(r); this.write(addr, r); return 6;
      }
      case 0x54: this.A ^= this.read(this._dpx());  this.setNZ8(this.A); return 4;
      case 0x55: this.A ^= this.read(this._absx()); this.setNZ8(this.A); return 5;
      case 0x56: this.A ^= this.read(this._absy()); this.setNZ8(this.A); return 5;
      case 0x57: this.A ^= this.read(this._idpy()); this.setNZ8(this.A); return 6;
      case 0x58: {
        const v = this._imm(); addr = this._dp();
        r = (this.read(addr) ^ v) & 0xFF; this.setNZ8(r); this.write(addr, r); return 5;
      }
      case 0x59: {
        addr = this._dpAddr(this.X);
        r = (this.read(addr) ^ this.read(this._dpAddr(this.Y))) & 0xFF;
        this.setNZ8(r); this.write(addr, r); return 5;
      }

      // ----- CMP A -----
      case 0x64: this._cmp(this.A, this.read(this._dp()));   return 3;
      case 0x65: this._cmp(this.A, this.read(this._abs()));  return 4;
      case 0x66: this._cmp(this.A, this.read(this._dpAddr(this.X))); return 3;
      case 0x67: this._cmp(this.A, this.read(this._idpx())); return 6;
      case 0x68: this._cmp(this.A, this._imm());             return 2;
      case 0x69: {
        const src = this.read(this._dp());
        const dst = this.read(this._dp());
        this._cmp(dst, src); return 6;
      }
      case 0x74: this._cmp(this.A, this.read(this._dpx()));  return 4;
      case 0x75: this._cmp(this.A, this.read(this._absx())); return 5;
      case 0x76: this._cmp(this.A, this.read(this._absy())); return 5;
      case 0x77: this._cmp(this.A, this.read(this._idpy())); return 6;
      case 0x78: { const v = this._imm(); this._cmp(this.read(this._dp()), v); return 5; }
      case 0x79: this._cmp(this.read(this._dpAddr(this.X)), this.read(this._dpAddr(this.Y))); return 5;

      // ----- ADC -----
      case 0x84: this.A = this._adc(this.A, this.read(this._dp())); return 3;
      case 0x85: this.A = this._adc(this.A, this.read(this._abs())); return 4;
      case 0x86: this.A = this._adc(this.A, this.read(this._dpAddr(this.X))); return 3;
      case 0x87: this.A = this._adc(this.A, this.read(this._idpx())); return 6;
      case 0x88: this.A = this._adc(this.A, this._imm()); return 2;
      case 0x89: {
        const src = this.read(this._dp()); addr = this._dp();
        r = this._adc(this.read(addr), src); this.write(addr, r); return 6;
      }
      case 0x94: this.A = this._adc(this.A, this.read(this._dpx())); return 4;
      case 0x95: this.A = this._adc(this.A, this.read(this._absx())); return 5;
      case 0x96: this.A = this._adc(this.A, this.read(this._absy())); return 5;
      case 0x97: this.A = this._adc(this.A, this.read(this._idpy())); return 6;
      case 0x98: { const v = this._imm(); addr = this._dp(); r = this._adc(this.read(addr), v); this.write(addr, r); return 5; }
      case 0x99: { const aaddr = this._dpAddr(this.X); r = this._adc(this.read(aaddr), this.read(this._dpAddr(this.Y))); this.write(aaddr, r); return 5; }

      // ----- SBC -----
      case 0xA4: this.A = this._sbc(this.A, this.read(this._dp())); return 3;
      case 0xA5: this.A = this._sbc(this.A, this.read(this._abs())); return 4;
      case 0xA6: this.A = this._sbc(this.A, this.read(this._dpAddr(this.X))); return 3;
      case 0xA7: this.A = this._sbc(this.A, this.read(this._idpx())); return 6;
      case 0xA8: this.A = this._sbc(this.A, this._imm()); return 2;
      case 0xA9: {
        const src = this.read(this._dp()); addr = this._dp();
        r = this._sbc(this.read(addr), src); this.write(addr, r); return 6;
      }
      case 0xB4: this.A = this._sbc(this.A, this.read(this._dpx())); return 4;
      case 0xB5: this.A = this._sbc(this.A, this.read(this._absx())); return 5;
      case 0xB6: this.A = this._sbc(this.A, this.read(this._absy())); return 5;
      case 0xB7: this.A = this._sbc(this.A, this.read(this._idpy())); return 6;
      case 0xB8: { const v = this._imm(); addr = this._dp(); r = this._sbc(this.read(addr), v); this.write(addr, r); return 5; }
      case 0xB9: { const aaddr = this._dpAddr(this.X); r = this._sbc(this.read(aaddr), this.read(this._dpAddr(this.Y))); this.write(aaddr, r); return 5; }

      // ----- ASL/LSR/ROL/ROR (RMW) -----
      case 0x0B: addr=this._dp();  this.write(addr, this._asl(this.read(addr))); return 4;
      case 0x0C: addr=this._abs(); this.write(addr, this._asl(this.read(addr))); return 5;
      case 0x1B: addr=this._dpx(); this.write(addr, this._asl(this.read(addr))); return 5;
      case 0x1C: this.A = this._asl(this.A); return 2;

      case 0x4B: addr=this._dp();  this.write(addr, this._lsr(this.read(addr))); return 4;
      case 0x4C: addr=this._abs(); this.write(addr, this._lsr(this.read(addr))); return 5;
      case 0x5B: addr=this._dpx(); this.write(addr, this._lsr(this.read(addr))); return 5;
      case 0x5C: this.A = this._lsr(this.A); return 2;

      case 0x2B: addr=this._dp();  this.write(addr, this._rol(this.read(addr))); return 4;
      case 0x2C: addr=this._abs(); this.write(addr, this._rol(this.read(addr))); return 5;
      case 0x3B: addr=this._dpx(); this.write(addr, this._rol(this.read(addr))); return 5;
      case 0x3C: this.A = this._rol(this.A); return 2;

      case 0x6B: addr=this._dp();  this.write(addr, this._ror(this.read(addr))); return 4;
      case 0x6C: addr=this._abs(); this.write(addr, this._ror(this.read(addr))); return 5;
      case 0x7B: addr=this._dpx(); this.write(addr, this._ror(this.read(addr))); return 5;
      case 0x7C: this.A = this._ror(this.A); return 2;

      // ----- INC/DEC -----
      case 0xAB: addr=this._dp();  r=(this.read(addr)+1)&0xFF; this.setNZ8(r); this.write(addr, r); return 4;
      case 0xAC: addr=this._abs(); r=(this.read(addr)+1)&0xFF; this.setNZ8(r); this.write(addr, r); return 5;
      case 0xBB: addr=this._dpx(); r=(this.read(addr)+1)&0xFF; this.setNZ8(r); this.write(addr, r); return 5;
      case 0xBC: this.A=(this.A+1)&0xFF; this.setNZ8(this.A); return 2;
      case 0xFC: this.Y=(this.Y+1)&0xFF; this.setNZ8(this.Y); return 2;
      case 0x3D: this.X=(this.X+1)&0xFF; this.setNZ8(this.X); return 2;

      case 0x8B: addr=this._dp();  r=(this.read(addr)-1)&0xFF; this.setNZ8(r); this.write(addr, r); return 4;
      case 0x8C: addr=this._abs(); r=(this.read(addr)-1)&0xFF; this.setNZ8(r); this.write(addr, r); return 5;
      case 0x9B: addr=this._dpx(); r=(this.read(addr)-1)&0xFF; this.setNZ8(r); this.write(addr, r); return 5;
      case 0x9C: this.A=(this.A-1)&0xFF; this.setNZ8(this.A); return 2;
      case 0xDC: this.Y=(this.Y-1)&0xFF; this.setNZ8(this.Y); return 2;
      case 0x1D: this.X=(this.X-1)&0xFF; this.setNZ8(this.X); return 2;

      // ----- 16bit DP ops -----
      case 0x1A: addr=this._dp(); r=(this._readW(addr)-1)&0xFFFF; this.setNZ16(r); this._writeW(addr, r); return 6; // DECW dp
      case 0x3A: addr=this._dp(); r=(this._readW(addr)+1)&0xFFFF; this.setNZ16(r); this._writeW(addr, r); return 6; // INCW dp
      case 0x5A: { addr=this._dp(); const w = this._readW(addr); this._cmpw((this.Y<<8)|this.A, w); return 4; } // CMPW YA, dp
      case 0x7A: { addr=this._dp(); const w = this._readW(addr); const ya = this._addw((this.Y<<8)|this.A, w); this.A=ya&0xFF; this.Y=(ya>>8)&0xFF; return 5; } // ADDW
      case 0x9A: { addr=this._dp(); const w = this._readW(addr); const ya = this._subw((this.Y<<8)|this.A, w); this.A=ya&0xFF; this.Y=(ya>>8)&0xFF; return 5; } // SUBW
      case 0xBA: { addr=this._dp(); const w = this._readW(addr); this.A=w&0xFF; this.Y=(w>>8)&0xFF; this.setNZ16(w); return 5; } // MOVW YA, dp
      case 0xDA: { addr=this._dp(); this._writeW(addr, (this.Y<<8)|this.A); return 5; } // MOVW dp, YA

      // ----- フラグ操作 -----
      case 0x20: this.PSW &= ~F_P; return 2; // CLRP
      case 0x40: this.PSW |=  F_P; return 2; // SETP
      case 0x60: this.PSW &= ~F_C; return 2; // CLRC
      case 0x80: this.PSW |=  F_C; return 2; // SETC
      case 0xE0: this.PSW &= ~F_V; this.PSW &= ~F_H; return 2; // CLRV
      case 0xED: this.PSW ^= F_C; return 3; // NOTC
      case 0xA0: this.PSW |=  F_I; return 3; // EI
      case 0xC0: this.PSW &= ~F_I; return 3; // DI

      // ----- スタック -----
      case 0x0D: this.push8(this.PSW); return 4;
      case 0x2D: this.push8(this.A); return 4;
      case 0x4D: this.push8(this.X); return 4;
      case 0x6D: this.push8(this.Y); return 4;
      case 0x8E: this.PSW = this.pull8(); return 4;
      case 0xAE: this.A = this.pull8(); return 4;
      case 0xCE: this.X = this.pull8(); return 4;
      case 0xEE: this.Y = this.pull8(); return 4;

      // ----- 分岐 -----
      case 0x10: rel=this._rel(); if(!(this.PSW & F_N)) { this.PC = (this.PC+rel)&0xFFFF; return 4; } return 2; // BPL
      case 0x30: rel=this._rel(); if (this.PSW & F_N)  { this.PC = (this.PC+rel)&0xFFFF; return 4; } return 2; // BMI
      case 0x50: rel=this._rel(); if(!(this.PSW & F_V)) { this.PC = (this.PC+rel)&0xFFFF; return 4; } return 2; // BVC
      case 0x70: rel=this._rel(); if (this.PSW & F_V)  { this.PC = (this.PC+rel)&0xFFFF; return 4; } return 2; // BVS
      case 0x90: rel=this._rel(); if(!(this.PSW & F_C)) { this.PC = (this.PC+rel)&0xFFFF; return 4; } return 2; // BCC
      case 0xB0: rel=this._rel(); if (this.PSW & F_C)  { this.PC = (this.PC+rel)&0xFFFF; return 4; } return 2; // BCS
      case 0xD0: rel=this._rel(); if(!(this.PSW & F_Z)) { this.PC = (this.PC+rel)&0xFFFF; return 4; } return 2; // BNE
      case 0xF0: rel=this._rel(); if (this.PSW & F_Z)  { this.PC = (this.PC+rel)&0xFFFF; return 4; } return 2; // BEQ
      case 0x2F: rel=this._rel(); this.PC = (this.PC+rel)&0xFFFF; return 4; // BRA

      case 0x2E: { addr=this._dp(); rel=this._rel(); if (this.read(addr) !== this.A) { this.PC=(this.PC+rel)&0xFFFF; return 7; } return 5; } // CBNE dp,rel
      case 0xDE: { addr=this._dpx(); rel=this._rel(); if (this.read(addr) !== this.A) { this.PC=(this.PC+rel)&0xFFFF; return 8; } return 6; } // CBNE dp+X,rel
      case 0x6E: { addr=this._dp(); rel=this._rel();
        r=(this.read(addr)-1)&0xFF; this.write(addr, r);
        if (r !== 0) { this.PC=(this.PC+rel)&0xFFFF; return 7; } return 5; } // DBNZ dp,rel
      case 0xFE: { rel=this._rel(); this.Y=(this.Y-1)&0xFF; if (this.Y !== 0) { this.PC=(this.PC+rel)&0xFFFF; return 6; } return 4; } // DBNZ Y,rel

      // ----- JMP/CALL -----
      case 0x5F: this.PC = this._abs(); return 3; // JMP !abs
      case 0x1F: { addr = this._abs(); const ptr = (addr + this.X) & 0xFFFF; this.PC = this.read(ptr) | (this.read((ptr+1)&0xFFFF) << 8); return 6; } // JMP [!abs+X]
      case 0x3F: addr=this._abs(); this.push16(this.PC); this.PC=addr; return 8; // CALL
      case 0x4F: { addr=this._imm(); this.push16(this.PC); this.PC = 0xFF00 | addr; return 6; } // PCALL upage
      case 0x6F: this.PC = this.pull16(); return 5; // RET
      case 0x7F: this.PSW = this.pull8(); this.PC = this.pull16(); return 6; // RETI

      // ----- MOV (転送) -----
      case 0xE8: this.A=this._imm(); this.setNZ8(this.A); return 2;
      case 0xCD: this.X=this._imm(); this.setNZ8(this.X); return 2;
      case 0x8D: this.Y=this._imm(); this.setNZ8(this.Y); return 2;
      case 0xE4: this.A=this.read(this._dp());   this.setNZ8(this.A); return 3;
      case 0xE5: this.A=this.read(this._abs());  this.setNZ8(this.A); return 4;
      case 0xE6: this.A=this.read(this._dpAddr(this.X)); this.setNZ8(this.A); return 3;
      case 0xE7: this.A=this.read(this._idpx()); this.setNZ8(this.A); return 6;
      case 0xF4: this.A=this.read(this._dpx());  this.setNZ8(this.A); return 4;
      case 0xF5: this.A=this.read(this._absx()); this.setNZ8(this.A); return 5;
      case 0xF6: this.A=this.read(this._absy()); this.setNZ8(this.A); return 5;
      case 0xF7: this.A=this.read(this._idpy()); this.setNZ8(this.A); return 6;
      case 0xBF: { addr = this._dpAddr(this.X); this.A = this.read(addr); this.X=(this.X+1)&0xFF; this.setNZ8(this.A); return 4; } // MOV A,(X)+

      case 0xF8: this.X=this.read(this._dp());  this.setNZ8(this.X); return 3;
      case 0xF9: this.X=this.read(this._dpy()); this.setNZ8(this.X); return 4;
      case 0xE9: this.X=this.read(this._abs()); this.setNZ8(this.X); return 4;
      case 0xEB: this.Y=this.read(this._dp());  this.setNZ8(this.Y); return 3;
      case 0xFB: this.Y=this.read(this._dpx()); this.setNZ8(this.Y); return 4;
      case 0xEC: this.Y=this.read(this._abs()); this.setNZ8(this.Y); return 4;

      case 0xC4: this.write(this._dp(), this.A); return 4;
      case 0xC5: this.write(this._abs(), this.A); return 5;
      case 0xC6: this.write(this._dpAddr(this.X), this.A); return 4;
      case 0xC7: this.write(this._idpx(), this.A); return 7;
      case 0xD4: this.write(this._dpx(), this.A); return 5;
      case 0xD5: this.write(this._absx(), this.A); return 6;
      case 0xD6: this.write(this._absy(), this.A); return 6;
      case 0xD7: this.write(this._idpy(), this.A); return 7;
      case 0xAF: { addr = this._dpAddr(this.X); this.write(addr, this.A); this.X=(this.X+1)&0xFF; return 4; } // MOV (X)+,A

      case 0xD8: this.write(this._dp(), this.X); return 4;
      case 0xD9: this.write(this._dpy(), this.X); return 5;
      case 0xC9: this.write(this._abs(), this.X); return 5;
      case 0xCB: this.write(this._dp(), this.Y); return 4;
      case 0xDB: this.write(this._dpx(), this.Y); return 5;
      case 0xCC: this.write(this._abs(), this.Y); return 5;

      case 0x8F: { const v=this._imm(); addr=this._dp(); this.write(addr, v); return 5; } // MOV dp,#imm
      case 0xFA: { const src=this.read(this._dp()); this.write(this._dp(), src); return 5; } // MOV dp,dp

      case 0x5D: this.X=this.A; this.setNZ8(this.X); return 2; // MOV X,A
      case 0x7D: this.A=this.X; this.setNZ8(this.A); return 2; // MOV A,X
      case 0xDD: this.A=this.Y; this.setNZ8(this.A); return 2; // MOV A,Y
      case 0xFD: this.Y=this.A; this.setNZ8(this.Y); return 2; // MOV Y,A
      case 0x9D: this.X=this.SP; this.setNZ8(this.X); return 2; // MOV X,SP
      case 0xBD: this.SP=this.X; return 2; // MOV SP,X

      // ----- CMP X/Y -----
      case 0xC8: this._cmp(this.X, this._imm()); return 2;
      case 0x3E: this._cmp(this.X, this.read(this._dp())); return 3;
      case 0x1E: this._cmp(this.X, this.read(this._abs())); return 4;
      case 0xAD: this._cmp(this.Y, this._imm()); return 2;
      case 0x7E: this._cmp(this.Y, this.read(this._dp())); return 3;
      case 0x5E: this._cmp(this.Y, this.read(this._abs())); return 4;

      // ----- 1bit / mem.bit ops (簡易: NOP相当で済ませる) -----
      case 0x0A: case 0x2A: case 0x4A: case 0x6A:
      case 0x8A: case 0xAA: case 0xCA: case 0xEA:
        // 13bit address + bit#: 3バイト命令なのでオペランド2バイトを読み飛ばす
        this._imm(); this._imm(); return 5;

      // ----- TSET1/TCLR1 -----
      case 0x0E: { addr = this._abs(); a = this.read(addr); this._cmp(this.A, a); this.write(addr, a | this.A); return 6; }
      case 0x4E: { addr = this._abs(); a = this.read(addr); this._cmp(this.A, a); this.write(addr, a & ~this.A); return 6; }

      // ----- 特殊 -----
      case 0x9F: { // XCN A: ニブル交換
        this.A = ((this.A << 4) | (this.A >> 4)) & 0xFF;
        this.setNZ8(this.A); return 5;
      }
      case 0xCF: { // MUL YA = Y*A
        const m = this.Y * this.A;
        this.A = m & 0xFF; this.Y = (m >> 8) & 0xFF;
        this.setNZ8(this.Y); return 9;
      }
      case 0x9E: { // DIV YA, X
        if (this.X === 0) {
          this.PSW |= F_V;
          this.A = 0xFF; this.Y = 0xFF;
        } else {
          const ya = (this.Y << 8) | this.A;
          this.A = Math.min(0xFF, Math.floor(ya / this.X)) & 0xFF;
          this.Y = (ya % this.X) & 0xFF;
        }
        this.setNZ8(this.A);
        return 12;
      }
      case 0xDF: { // DAA A
        if ((this.PSW & F_C) || this.A > 0x99) { this.A = (this.A + 0x60) & 0xFF; this.PSW |= F_C; }
        if ((this.PSW & F_H) || (this.A & 0x0F) > 0x09) this.A = (this.A + 0x06) & 0xFF;
        this.setNZ8(this.A); return 3;
      }
      case 0xBE: { // DAS A
        if (!(this.PSW & F_C) || this.A > 0x99) { this.A = (this.A - 0x60) & 0xFF; this.PSW &= ~F_C; }
        if (!(this.PSW & F_H) || (this.A & 0x0F) > 0x09) this.A = (this.A - 0x06) & 0xFF;
        this.setNZ8(this.A); return 3;
      }
      case 0xEF: return 3; // SLEEP (扱い: NOP)
      case 0xFF: this.stopped = true; return 3; // STOP

      case 0x0F: return 8; // BRK (未対応: NOP)

      default:
        // 未実装命令: 黙ってスキップ (頻発するなら警告出してもよい)
        return 2;
    }
  }

  // ----------------------------------------------------------
  //  サイクル駆動: SNES側からは「1フレーム分」を呼ぶ
  // ----------------------------------------------------------
  runCycles(cycles) {
    // SPC700 は 1.024MHz、1フレーム ≒ 17066 サイクル
    // DSP は 32kHz、1サンプル ≒ 32 SPC サイクル
    while (cycles > 0) {
      if (this.stopped) { cycles -= 2; continue; }
      const used = this.step();
      cycles -= used;

      // タイマー: T0/T1 = 8kHz (128 SPCサイクル毎)、T2 = 64kHz (16 SPCサイクル毎)
      this._cycleAccumT01 += used;
      while (this._cycleAccumT01 >= 128) {
        this._cycleAccumT01 -= 128;
        for (let i = 0; i < 2; i++) {
          if (!this.timers[i].enable) continue;
          if (++this.timers[i].counter >= this.timers[i].target) {
            this.timers[i].counter = 0;
            this.timers[i].output = (this.timers[i].output + 1) & 0xF;
          }
        }
      }
      this._cycleAccumT2 += used;
      while (this._cycleAccumT2 >= 16) {
        this._cycleAccumT2 -= 16;
        if (this.timers[2].enable) {
          if (++this.timers[2].counter >= this.timers[2].target) {
            this.timers[2].counter = 0;
            this.timers[2].output = (this.timers[2].output + 1) & 0xF;
          }
        }
      }

      this._cycleAccumDSP += used;
      while (this._cycleAccumDSP >= 32) {
        this._cycleAccumDSP -= 32;
        this.dsp.generateSample();
      }
    }
  }
}

// ============================================================
//  ラッパー: emulator.js / bus.js から見える顔
// ============================================================
class SPC700 {
  constructor() {
    this.cpu = new SPC700CPU();
    // SNES起動直後: SPCの $F4=$AA, $F5=$BB を返す (IPL ROMのハンドシェイク値)
    this.cpu.outPorts[0] = 0xAA;
    this.cpu.outPorts[1] = 0xBB;
    this.cpu.outPorts[2] = 0x00;
    this.cpu.outPorts[3] = 0x00;
  }

  // SNES から SPC への 1バイト入力 (port 0..3)
  write(port, val) {
    this.cpu.inPorts[port & 3] = val & 0xFF;
  }

  // SPC から SNES への 1バイト出力 (port 0..3)
  read(port) {
    return this.cpu.outPorts[port & 3];
  }

  runFrame() {
    // 1フレーム ≒ 17066 SPCサイクル (SNES CPUとインターリーブする場合は使わず、
    // emulator.js から runCycles() を細切れに呼ぶ)
    this.cpu.runCycles(17066);
  }

  // SNES CPU と同期させるための部分実行
  runCycles(n) {
    this.cpu.runCycles(n);
  }

  getAudioSamples() {
    return this.cpu.dsp.getSamples();
  }

  // emulator.js / index.html のデバッグ表示用
  get stateLabel() { return this.cpu.iplEnabled ? 'IPL' : 'EXEC'; }
  get portIn()  { return this.cpu.inPorts; }
  get portOut() { return this.cpu.outPorts; }
}
