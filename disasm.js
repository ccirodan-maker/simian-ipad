// ============================================================
// disasm.js  ―  65816 逆アセンブラ
//   デバッグパネルで次の数命令を表示するために使用
// ============================================================
const DISASM = (() => {
  // アドレッシングモード定数
  const IMP ='imp', ACC='acc', IMM='imm', IMMM='immm', IMMX='immx',
        DP  ='dp',  DPX='dpx', DPY='dpy',
        DPI ='dpi', DPIX='dpix', DPIY='dpiy',
        DPL ='dpl', DPLY='dply',
        ABS ='abs', ABSX='absx', ABSY='absy',
        ABL ='abl', ABLX='ablx',
        REL ='rel', RELL='rell',
        IND ='ind', INDX='indx',
        SR  ='sr',  SRIY='sriy',
        MVP ='mvp', MVN='mvn';

  // [mnemonic, addressing_mode]
  const OPS = [
    ['BRK',IMP ],['ORA',DPIX],['COP',IMP ],['ORA',SR  ],['TSB',DP  ],['ORA',DP  ],['ASL',DP  ],['ORA',DPL ],
    ['PHP',IMP ],['ORA',IMMM],['ASL',ACC ],['PHD',IMP ],['TSB',ABS ],['ORA',ABS ],['ASL',ABS ],['ORA',ABL ],
    ['BPL',REL ],['ORA',DPIY],['ORA',DPI ],['ORA',SRIY],['TRB',DP  ],['ORA',DPX ],['ASL',DPX ],['ORA',DPLY],
    ['CLC',IMP ],['ORA',ABSY],['INC',ACC ],['TCS',IMP ],['TRB',ABS ],['ORA',ABSX],['ASL',ABSX],['ORA',ABLX],
    ['JSR',ABS ],['AND',DPIX],['JSL',ABL ],['AND',SR  ],['BIT',DP  ],['AND',DP  ],['ROL',DP  ],['AND',DPL ],
    ['PLP',IMP ],['AND',IMMM],['ROL',ACC ],['PLD',IMP ],['BIT',ABS ],['AND',ABS ],['ROL',ABS ],['AND',ABL ],
    ['BMI',REL ],['AND',DPIY],['AND',DPI ],['AND',SRIY],['BIT',DPX ],['AND',DPX ],['ROL',DPX ],['AND',DPLY],
    ['SEC',IMP ],['AND',ABSY],['DEC',ACC ],['TSC',IMP ],['BIT',ABSX],['AND',ABSX],['ROL',ABSX],['AND',ABLX],
    ['RTI',IMP ],['EOR',DPIX],['WDM',IMP ],['EOR',SR  ],['MVP',MVP ],['EOR',DP  ],['LSR',DP  ],['EOR',DPL ],
    ['PHA',IMP ],['EOR',IMMM],['LSR',ACC ],['PHK',IMP ],['JMP',ABS ],['EOR',ABS ],['LSR',ABS ],['EOR',ABL ],
    ['BVC',REL ],['EOR',DPIY],['EOR',DPI ],['EOR',SRIY],['MVN',MVN ],['EOR',DPX ],['LSR',DPX ],['EOR',DPLY],
    ['CLI',IMP ],['EOR',ABSY],['PHY',IMP ],['TCD',IMP ],['JML',ABL ],['EOR',ABSX],['LSR',ABSX],['EOR',ABLX],
    ['RTS',IMP ],['ADC',DPIX],['PER',RELL],['ADC',SR  ],['STZ',DP  ],['ADC',DP  ],['ROR',DP  ],['ADC',DPL ],
    ['PLA',IMP ],['ADC',IMMM],['ROR',ACC ],['RTL',IMP ],['JMP',IND ],['ADC',ABS ],['ROR',ABS ],['ADC',ABL ],
    ['BVS',REL ],['ADC',DPIY],['ADC',DPI ],['ADC',SRIY],['STZ',DPX ],['ADC',DPX ],['ROR',DPX ],['ADC',DPLY],
    ['SEI',IMP ],['ADC',ABSY],['PLY',IMP ],['TDC',IMP ],['JMP',INDX],['ADC',ABSX],['ROR',ABSX],['ADC',ABLX],
    ['BRA',REL ],['STA',DPIX],['BRL',RELL],['STA',SR  ],['STY',DP  ],['STA',DP  ],['STX',DP  ],['STA',DPL ],
    ['DEY',IMP ],['BIT',IMMM],['TXA',IMP ],['PHB',IMP ],['STY',ABS ],['STA',ABS ],['STX',ABS ],['STA',ABL ],
    ['BCC',REL ],['STA',DPIY],['STA',DPI ],['STA',SRIY],['STY',DPX ],['STA',DPX ],['STX',DPY ],['STA',DPLY],
    ['TYA',IMP ],['STA',ABSY],['TXS',IMP ],['TXY',IMP ],['STZ',ABS ],['STA',ABSX],['STZ',ABSX],['STA',ABLX],
    ['LDY',IMMX],['LDA',DPIX],['LDX',IMMX],['LDA',SR  ],['LDY',DP  ],['LDA',DP  ],['LDX',DP  ],['LDA',DPL ],
    ['TAY',IMP ],['LDA',IMMM],['TAX',IMP ],['PLB',IMP ],['LDY',ABS ],['LDA',ABS ],['LDX',ABS ],['LDA',ABL ],
    ['BCS',REL ],['LDA',DPIY],['LDA',DPI ],['LDA',SRIY],['LDY',DPX ],['LDA',DPX ],['LDX',DPY ],['LDA',DPLY],
    ['CLV',IMP ],['LDA',ABSY],['TSX',IMP ],['TYX',IMP ],['LDY',ABSX],['LDA',ABSX],['LDX',ABSY],['LDA',ABLX],
    ['CPY',IMMX],['CMP',DPIX],['REP',IMP ],['CMP',SR  ],['CPY',DP  ],['CMP',DP  ],['DEC',DP  ],['CMP',DPL ],
    ['INY',IMP ],['CMP',IMMM],['DEX',IMP ],['WAI',IMP ],['CPY',ABS ],['CMP',ABS ],['DEC',ABS ],['CMP',ABL ],
    ['BNE',REL ],['CMP',DPIY],['CMP',DPI ],['CMP',SRIY],['PEI',DPI ],['CMP',DPX ],['DEC',DPX ],['CMP',DPLY],
    ['CLD',IMP ],['CMP',ABSY],['PHX',IMP ],['STP',IMP ],['JML',IND ],['CMP',ABSX],['DEC',ABSX],['CMP',ABLX],
    ['CPX',IMMX],['SBC',DPIX],['SEP',IMP ],['SBC',SR  ],['CPX',DP  ],['SBC',DP  ],['INC',DP  ],['SBC',DPL ],
    ['INX',IMP ],['SBC',IMMM],['NOP',IMP ],['XBA',IMP ],['CPX',ABS ],['SBC',ABS ],['INC',ABS ],['SBC',ABL ],
    ['BEQ',REL ],['SBC',DPIY],['SBC',DPI ],['SBC',SRIY],['PEA',ABS ],['SBC',DPX ],['INC',DPX ],['SBC',DPLY],
    ['SED',IMP ],['SBC',ABSY],['PLX',IMP ],['XCE',IMP ],['JSR',INDX],['SBC',ABSX],['INC',ABSX],['SBC',ABLX],
  ];

  // バイト列を hex 文字列に
  function hex2(v) { return v.toString(16).padStart(2,'0'); }
  function hex4(v) { return v.toString(16).padStart(4,'0'); }
  function hex6(v) { return v.toString(16).padStart(6,'0'); }

  // 1命令を逆アセンブル。{addr, bytes, text, size} を返す
  function disasm1(bus, addr24, flagM, flagX, flagE) {
    const m8 = flagE || flagM;
    const x8 = flagE || flagX;

    function r8(a)  { return bus.read(a & 0xFFFFFF); }
    function r16(a) { return r8(a) | (r8((a+1)&0xFFFFFF) << 8); }

    let pc  = addr24;
    const bytes = [];
    const b8 = () => { const v = r8(pc); bytes.push(v); pc = (pc & 0xFF0000) | ((pc+1) & 0xFFFF); return v; };
    const w16= () => { const lo=b8(), hi=b8(); return lo|(hi<<8); };
    const w24= () => { const lo=b8(), mi=b8(), hi=b8(); return lo|(mi<<8)|(hi<<16); };

    const op  = b8();
    const [mn, mode] = OPS[op];

    let operand = '';
    switch(mode) {
      case IMP:  break;
      case ACC:  operand='A'; break;
      case IMM:  operand='#$'+hex2(b8()); break;
      case IMMM: {
        if(m8){operand='#$'+hex2(b8());}
        else  {operand='#$'+hex4(w16());}
        break;
      }
      case IMMX: {
        if(x8){operand='#$'+hex2(b8());}
        else  {operand='#$'+hex4(w16());}
        break;
      }
      case DP:   operand='$'+hex2(b8()); break;
      case DPX:  operand='$'+hex2(b8())+',X'; break;
      case DPY:  operand='$'+hex2(b8())+',Y'; break;
      case DPI:  operand='($'+hex2(b8())+')'; break;
      case DPIX: operand='($'+hex2(b8())+',X)'; break;
      case DPIY: operand='($'+hex2(b8())+'),Y'; break;
      case DPL:  operand='[$'+hex2(b8())+']'; break;
      case DPLY: operand='[$'+hex2(b8())+'],Y'; break;
      case ABS:  operand='$'+hex4(w16()); break;
      case ABSX: operand='$'+hex4(w16())+',X'; break;
      case ABSY: operand='$'+hex4(w16())+',Y'; break;
      case ABL:  operand='$'+hex6(w24()); break;
      case ABLX: operand='$'+hex6(w24())+',X'; break;
      case IND:  operand='($'+hex4(w16())+')'; break;
      case INDX: operand='($'+hex4(w16())+',X)'; break;
      case REL:  { const o=b8(); const target=(pc&0xFFFF)+(o&0x80?o-256:o); operand='$'+hex4(target&0xFFFF); break; }
      case RELL: { const o=w16(); const target=(pc&0xFFFF)+(o&0x8000?o-65536:o); operand='$'+hex4(target&0xFFFF); break; }
      case SR:   operand='$'+hex2(b8())+',S'; break;
      case SRIY: operand='($'+hex2(b8())+',S),Y'; break;
      case MVP:
      case MVN:  { const dst=b8(), src=b8(); operand='$'+hex2(dst)+',$'+hex2(src); break; }
    }

    const byteStr = bytes.map(hex2).join(' ').padEnd(9,' ');
    const text    = hex6(addr24)+': '+byteStr+' '+mn+(operand?' '+operand:'');

    return { addr: addr24, bytes, text, size: bytes.length };
  }

  // 複数命令を逆アセンブル
  function disasmN(bus, addr24, flagM, flagX, flagE, count) {
    const result = [];
    for (let i = 0; i < count; i++) {
      const d = disasm1(bus, addr24, flagM, flagX, flagE);
      result.push(d);
      addr24 = (addr24 & 0xFF0000) | ((addr24 + d.size) & 0xFFFF);
    }
    return result;
  }

  return { disasm1, disasmN };
})();
