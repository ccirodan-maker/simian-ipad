// ============================================================
// emulator.js  v6.2
//   Phase 6: Web Audio API 連携 (クラッシュ対策フェイルセーフ版)
// ============================================================
const JOY_B=0x8000,JOY_Y=0x4000,JOY_SELECT=0x2000,JOY_START=0x1000;
const JOY_UP=0x0800,JOY_DOWN=0x0400,JOY_LEFT=0x0200,JOY_RIGHT=0x0100;
const JOY_A=0x0080,JOY_X=0x0040,JOY_L=0x0020,JOY_R=0x0010;

const DEFAULT_KEYMAP = {
  'z':JOY_B,'a':JOY_Y,'Shift':JOY_SELECT,'Enter':JOY_START,
  'ArrowUp':JOY_UP,'ArrowDown':JOY_DOWN,'ArrowLeft':JOY_LEFT,'ArrowRight':JOY_RIGHT,
  'x':JOY_A,'s':JOY_X,'q':JOY_L,'w':JOY_R,
};

class Emulator {
  static CPU_CYCLES_PER_LINE = 500;
  static SCANLINES            = 262;
  static ACTIVE_LINES         = 224;
  static FRAME_MS             = 1000 / 60;

  constructor() {
    this.cart=null; this.bus=null; this.cpu=null; this.ppu=null; this.apu=null;
    this.running=false; this._rafId=null;
    this._fps=0; this._frameCount=0; this._lastFPSTime=0;
    this._lastFrameAt=0;
    this._skipCount=0;
    this.onFrame=null;
    this._keymap={...DEFAULT_KEYMAP};
    this._joy1raw=0;
    this._gamepadJoy1=0;       // ゲームパッド由来のボタン状態
    this._gamepadIndex=-1;     // 接続中のゲームパッド添字 (-1=未接続)
    this.onGamepadStatus=null; // (connected:boolean, id:string) を渡すコールバック
    this._setupKeyboard();
    this._setupGamepad();

    // ---- Web Audio API ----
    this.audioCtx = null;
    this.nextAudioTime = 0;
  }

  loadROM(buf) {
    this.cart = new Cartridge(buf);
    this.bus  = new Bus(this.cart);
    this.ppu  = new PPU();
    this.apu  = new SPC700();
    this.cpu  = new CPU65816(this.bus);
    this.bus.ppu=this.ppu; this.bus.cpu=this.cpu; this.bus.apu=this.apu;
    
    // ★修正箇所：verifyChecksumが存在しない場合のクラッシュを回避
    let ok = true;
    if (typeof this.cart.verifyChecksum === 'function') {
      ok = this.cart.verifyChecksum();
    }
    
    console.log(`[EMU] "${this.cart.title.trim()}"  cs:${ok?'OK':'FAIL'}  PC:$${this.cpu.PC.toString(16).padStart(4,'0')}`);
    this._loadSRAM();
    return ok;
  }

  setCanvas(c) { if(this.ppu) this.ppu.setCanvas(c); }

  _setupKeyboard() {
    document.addEventListener('keydown',e=>{
      const bit=this._keymap[e.key]||this._keymap[e.code]; if(!bit) return;
      this._joy1raw|=bit; this._syncJoyToBus();
    });
    document.addEventListener('keyup',e=>{
      const bit=this._keymap[e.key]||this._keymap[e.code]; if(!bit) return;
      this._joy1raw&=~bit; this._syncJoyToBus();
    });
  }

  // キーボード入力 + ゲームパッド入力を OR 合成して bus に反映
  _syncJoyToBus() {
    if (this.bus) this.bus.joy1raw = (this._joy1raw | this._gamepadJoy1) & 0xFFFF;
  }

  // ----------------------------------------------------------
  //  ゲームパッド (PS5 DualSense / Xbox / その他 standard mapping)
  //
  //  PS5 のフェイスボタンは SNES と物理配置が同じ:
  //    × (下) → SNES B   ○ (右) → SNES A
  //    □ (左) → SNES Y   △ (上) → SNES X
  //  これに合わせて自然なマッピングを採用。
  // ----------------------------------------------------------
  _setupGamepad() {
    if (typeof window === 'undefined') return;
    window.addEventListener('gamepadconnected', e => {
      this._gamepadIndex = e.gamepad.index;
      if (this.onGamepadStatus) this.onGamepadStatus(true, e.gamepad.id);
    });
    window.addEventListener('gamepaddisconnected', e => {
      if (this._gamepadIndex === e.gamepad.index) {
        this._gamepadIndex = -1;
        this._gamepadJoy1 = 0;
        this._syncJoyToBus();
        if (this.onGamepadStatus) this.onGamepadStatus(false, e.gamepad.id);
      }
    });
  }

  _pollGamepad() {
    if (this._gamepadIndex < 0) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads[this._gamepadIndex];
    if (!gp) return;
    const b = gp.buttons || [];
    const a = gp.axes || [];
    const pressed = i => b[i] && (b[i].pressed || b[i].value > 0.5);

    let joy = 0;
    // フェイスボタン (×=B, ○=A, □=Y, △=X)
    if (pressed(0)) joy |= JOY_B;
    if (pressed(1)) joy |= JOY_A;
    if (pressed(2)) joy |= JOY_Y;
    if (pressed(3)) joy |= JOY_X;
    // ショルダー (L1/L2 → SNES L、R1/R2 → SNES R)
    if (pressed(4) || pressed(6)) joy |= JOY_L;
    if (pressed(5) || pressed(7)) joy |= JOY_R;
    // センター (Create/Share=Select, Options=Start)
    if (pressed(8))  joy |= JOY_SELECT;
    if (pressed(9))  joy |= JOY_START;
    // 十字キー
    if (pressed(12)) joy |= JOY_UP;
    if (pressed(13)) joy |= JOY_DOWN;
    if (pressed(14)) joy |= JOY_LEFT;
    if (pressed(15)) joy |= JOY_RIGHT;
    // 左アナログスティック (デッドゾーン 0.4)
    const dz = 0.4;
    if ((a[0]||0) < -dz) joy |= JOY_LEFT;
    if ((a[0]||0) >  dz) joy |= JOY_RIGHT;
    if ((a[1]||0) < -dz) joy |= JOY_UP;
    if ((a[1]||0) >  dz) joy |= JOY_DOWN;

    if (joy !== this._gamepadJoy1) {
      this._gamepadJoy1 = joy;
      this._syncJoyToBus();
    }
  }

  start() {
    if(!this.cpu||this.running) return;

    // Web Audio API の初期化 (エラーが出てもクラッシュさせない)
    try {
      if (!this.audioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) this.audioCtx = new AudioCtx(); // 引数なしで安全に初期化
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      if (this.audioCtx) {
        this.nextAudioTime = this.audioCtx.currentTime + 0.05;
      }
    } catch(e) {
      console.warn("Web Audio API の初期化に失敗しました。無音で続行します:", e);
      this.audioCtx = null;
    }

    this.running=true; this._lastFPSTime=performance.now();
    this._lastFrameAt=performance.now();
    this._scheduleFrame();
  }

  stop() {
    this.running=false;
    if(this._rafId){cancelAnimationFrame(this._rafId);this._rafId=null;}
  }

  reset() {
    this._joy1raw=0;
    if(this.apu){
      this.apu.portOut[0]=0xAA; this.apu.portOut[1]=0xBB;
    }
    if(this.cpu) this.cpu.reset();
    if(this.bus) { this.bus.joy1raw=0; this.bus.wram.fill(0); }
  }

  _sramKey() {
    if(!this.cart) return null;
    return 'sfc_sram_' + this.cart.title.trim().replace(/\s+/g,'_');
  }
  
  saveSRAM() {
    if(!this.cart||!this.cart.ramSizeKB) return false;
    const key = this._sramKey();
    if(!key) return false;
    try {
      const b64 = btoa(String.fromCharCode(...this.cart.sram));
      localStorage.setItem(key, b64);
      this.cart.sramDirty = false;
      if (this.onAutoSave) this.onAutoSave();
      return true;
    } catch(e) { return false; }
  }

  // ゲームが SRAM に書き込んだ後、しばらく書き込みが止んだら自動保存する。
  // 連続書き込み中の保存スパムを防ぐため idle 判定を入れる。
  _autoSaveSRAMIfIdle() {
    if (!this.cart || !this.cart.sramDirty) return;
    const idleMs = (performance.now() - this.cart.sramLastWriteAt);
    if (idleMs >= 800) {       // 0.8秒間 書き込みが止んだら保存
      this.saveSRAM();
    }
  }

  // ページが閉じられるときなど、確実に保存させたい場面で呼ぶ
  flushSRAM() {
    if (this.cart && this.cart.sramDirty) this.saveSRAM();
  }
  
  _loadSRAM() {
    if(!this.cart||!this.cart.ramSizeKB) return false;
    const key = this._sramKey();
    if(!key) return false;
    try {
      const b64 = localStorage.getItem(key);
      if(!b64) return false;
      const bytes = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
      const len = Math.min(bytes.length, this.cart.sram.length);
      this.cart.sram.set(bytes.subarray(0, len));
      return true;
    } catch(e) { return false; }
  }

  _runFrame() {
    // ゲームパッドの状態を毎フレーム反映 (Gamepad API はポーリング型)
    this._pollGamepad();

    const CPL = Emulator.CPU_CYCLES_PER_LINE;
    // 1フレーム = 17066 SPCサイクル (1.024MHz / 60Hz)
    // スキャンラインあたり 17066/262 ≈ 65.14 を整数で正確に分配する
    const SPC_PER_FRAME = 17066;
    this.bus.startFrame();
    let spcRanThisFrame = 0;

    for (let sl=0;sl<Emulator.SCANLINES;sl++) {
      this.bus.updateTiming(sl);

      // このスキャンラインで実行すべき SPC 累積サイクル
      const spcTargetEnd = Math.floor((sl + 1) * SPC_PER_FRAME / Emulator.SCANLINES);
      const spcThisLine  = spcTargetEnd - spcRanThisFrame;
      const chunk = Math.max(1, (spcThisLine >> 2));  // ≈ 1/4 ずつ

      let c = 0;
      let spcRanThisLine = 0;
      let nextSpcAt = CPL >> 2;
      while (c < CPL) {
        if (this.cpu.stopped) { c += 2; break; }
        c += this.cpu.step();
        if (this.apu && c >= nextSpcAt && spcRanThisLine < spcThisLine) {
          const n = Math.min(chunk, spcThisLine - spcRanThisLine);
          try { this.apu.runCycles(n); } catch(e) {}
          spcRanThisLine += n;
          nextSpcAt += CPL >> 2;
        }
      }
      // スキャンライン終端で残りを消化
      if (this.apu && spcRanThisLine < spcThisLine) {
        try { this.apu.runCycles(spcThisLine - spcRanThisLine); } catch(e) {}
      }
      spcRanThisFrame = spcTargetEnd;

      if(sl<Emulator.ACTIVE_LINES) this.ppu.renderScanline(sl);
    }

    this.ppu._blitToCanvas();

    // 音声再生 (DSP のサンプルバッファは runCycles 内で蓄積されている)
    if(this.apu) {
      try {
        if (this.apu.getAudioSamples) {
          const samples = this.apu.getAudioSamples();
          if (samples) this._playAudio(samples);
        }
      } catch(e) {
        // 音声処理でエラーが起きても無視
      }
    }

    this._frameCount++;
    const now=performance.now();
    if(now-this._lastFPSTime>=1000){
      this._fps=Math.round(this._frameCount*1000/(now-this._lastFPSTime));
      this._frameCount=0; this._lastFPSTime=now;
    }

    // SRAM 自動保存 (書き込みが止んでから 0.8 秒後)
    this._autoSaveSRAMIfIdle();

    if(this.onFrame) this.onFrame(this._fps,this._getCPUState());
  }

  _scheduleFrame() {
    if(!this.running) return;
    this._rafId=requestAnimationFrame(now=>{
      try{
        this._runFrame();
      }catch(e){
        console.error('[EMU] frame error:', e);
        this.stop();
      }
      this._scheduleFrame();
    });
  }

  _playAudio(samples) {
    if (!this.audioCtx || !samples || samples.left.length === 0) return;
    try {
      const buffer = this.audioCtx.createBuffer(2, samples.left.length, 32000);
      buffer.getChannelData(0).set(samples.left);
      buffer.getChannelData(1).set(samples.right);

      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioCtx.destination);

      // 出力レイテンシを 50〜150ms にクランプ
      // (CPUとAPUの実行レート差で nextAudioTime が単調に未来へ進むのを防ぐ)
      const t = this.audioCtx.currentTime;
      const targetLatency = 0.05; // 50ms
      const maxLatency    = 0.15; // 150ms
      if (this.nextAudioTime < t + 0.001 || this.nextAudioTime > t + maxLatency) {
        this.nextAudioTime = t + targetLatency;
      }
      source.start(this.nextAudioTime);
      this.nextAudioTime += buffer.duration;
    } catch (e) {
      // 再生エラーは無視
    }
  }

  stepInstruction() {
    if(!this.cpu) return null;
    this.cpu.step();
    return this._getCPUState();
  }

  disasmAt(addr24, count=10) {
    if(!this.bus||!this.cpu) return [];
    return DISASM.disasmN(this.bus, addr24, this.cpu.flagM, this.cpu.flagX, this.cpu.flagE, count);
  }

  dumpMem(addr, len=128) {
    if(!this.bus) return '';
    let o='';
    for(let i=0;i<len;i+=16){
      o+=(addr+i).toString(16).padStart(6,'0')+': ';
      const ascii=[];
      for(let j=0;j<16&&i+j<len;j++){
        const v=this.bus.read(addr+i+j);
        o+=v.toString(16).padStart(2,'0')+' ';
        ascii.push(v>=0x20&&v<0x7F?String.fromCharCode(v):'.');
      }
      o+=' '+ascii.join('')+'\n';
    }
    return o;
  }

  _getCPUState() {
    if(!this.cpu) return null;
    const c=this.cpu;
    return {
      PC:  c.PBR.toString(16).padStart(2,'0')+':'+c.PC.toString(16).padStart(4,'0'),
      A:   (c.m8?c.A&0xFF:c.A).toString(16).padStart(c.m8?2:4,'0'),
      X:   (c.x8?c.X&0xFF:c.X).toString(16).padStart(c.x8?2:4,'0'),
      Y:   (c.x8?c.Y&0xFF:c.Y).toString(16).padStart(c.x8?2:4,'0'),
      SP:  c.SP.toString(16).padStart(4,'0'),
      DP:  c.DP.toString(16).padStart(4,'0'),
      DBR: c.DBR.toString(16).padStart(2,'0'),
      P:   c.getP().toString(16).padStart(2,'0'),
      E:   c.flagE,
      flags:`${c.flagN?'N':'-'}${c.flagV?'V':'-'}${c.flagM?'M':'-'}${c.flagX?'X':'-'}${c.flagD?'D':'-'}${c.flagI?'I':'-'}${c.flagZ?'Z':'-'}${c.flagC?'C':'-'}${c.flagE?'e':'-'}`,
      cycles:c.cycles, stopped:c.stopped, waiting:c.waiting,
      nextOp:c.bus.read((c.PBR<<16)|c.PC).toString(16).padStart(2,'0'),
      ppu: this.ppu?{
        mode:this.ppu.bgmode&7,
        inidisp:this.ppu.inidisp.toString(16).padStart(2,'0'),
        tm:this.ppu.tm.toString(16).padStart(2,'0'),
        ts:this.ppu.ts.toString(16).padStart(2,'0'),
        tmw:this.ppu.tmw.toString(16).padStart(2,'0'),
        frames:this.ppu.frameCount,
      }:null,
      apu: this.apu?{
        state:this.apu.stateLabel || 'BOOT',
        p0:'$'+(this.apu.portOut?this.apu.portOut[0].toString(16).padStart(2,'0'):'00'),
        p1:'$'+(this.apu.portOut?this.apu.portOut[1].toString(16).padStart(2,'0'):'00'),
      }:null,
    };
  }

  get cpuState(){return this._getCPUState();}
  get fps(){return this._fps;}
}