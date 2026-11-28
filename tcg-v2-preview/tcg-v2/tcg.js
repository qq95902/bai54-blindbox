(() => {
  'use strict';

  const STORAGE_KEY = 'bai-tcg-v2-cyber-demo-v4';
  const CARD_SET_VERSION = 2;
  const LANG_KEY = 'bai54-language';
  let language = 'zh';
  try { language = localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh'; } catch {}
  const RARITIES = [
    { id: 'N', grade: 'R', label: 'Common', labelZh:'普通', color: '#b8c5d5' },
    { id: 'R', grade: 'SR', label: 'Rare', labelZh:'稀有', color: '#52dfc0' },
    { id: 'SR', grade: 'S', label: 'Super Rare', labelZh:'超稀有', color: '#57c9ff' },
    { id: 'SSR', grade: 'SS', label: 'Epic', labelZh:'史诗', color: '#bd8cff' },
    { id: 'UR', grade: 'SSS', label: 'Legendary', labelZh:'传说', color: '#ffb84d' }
  ];
  const BATCH_ID = 'S01';
  // Requested demo pack prices. This does not imply that a sale contract is deployed.
  const PACK_PRICE_USDT = Object.freeze({ starter:1.88, bronze:8.88, gold:28.88, genesis:188.88 });
  const CARDS = [
    { code:'GC-001',sprite:0,sheet:1, name:'采矿学徒', en:'ORE APPRENTICE', rarity:'N', element:'土', glyph:'⌖', atk:18, def:22, skill:'矿脉感知：探索时更容易找到基础晶矿。', faction:'边境工坊' },
    { code:'GC-002',sprite:1,sheet:1, name:'信标信使', en:'BEACON RUNNER', rarity:'N', element:'风', glyph:'➤', atk:24, def:15, skill:'快速传讯：为队伍提供先手优势。', faction:'远航公会' },
    { code:'GC-003',sprite:2,sheet:1, name:'微光护卫', en:'GLOW GUARD', rarity:'N', element:'光', glyph:'✦', atk:15, def:28, skill:'微光屏障：抵挡一次轻型冲击。', faction:'星环守望' },
    { code:'GC-004',sprite:3,sheet:1, name:'苔原修补师', en:'TUNDRA MENDER', rarity:'N', element:'水', glyph:'✚', atk:13, def:27, skill:'苔原修复：缓慢恢复队伍耐久。', faction:'边境工坊' },
    { code:'GC-005',sprite:0,sheet:2, name:'折跃拾荒者', en:'RIFT SCAVENGER', rarity:'N', element:'暗', glyph:'⌁', atk:25, def:17, skill:'折跃拾取：从废墟中带回额外素材。', faction:'远航公会' },
    { code:'GC-006',sprite:1,sheet:2, name:'熔炉点火员', en:'FURNACE KEEPER', rarity:'N', element:'火', glyph:'♨', atk:27, def:15, skill:'炉火不熄：火元素队友获得小幅增益。', faction:'星环守望' },
    { code:'GC-007',sprite:2,sheet:2, name:'回声测绘员', en:'ECHO CARTOGRAPHER', rarity:'R', element:'风', glyph:'⌘', atk:32, def:25, skill:'回声定位：揭示下一段航路的危险。', faction:'远航公会' },
    { code:'GC-008',sprite:3,sheet:2, name:'晶格巡游者', en:'LATTICE RANGER', rarity:'R', element:'光', glyph:'◇', atk:38, def:21, skill:'晶格标记：对被标记目标造成额外伤害。', faction:'星环守望' },
    { code:'GC-009',sprite:0,sheet:3, name:'潮汐驯兽师', en:'TIDE TAMER', rarity:'R', element:'水', glyph:'≋', atk:29, def:35, skill:'潮汐协奏：水元素卡牌获得守护。', faction:'深蓝议会' },
    { code:'GC-010',sprite:1,sheet:3, name:'砂海工程师', en:'DUNE ENGINEER', rarity:'R', element:'土', glyph:'⛭', atk:34, def:32, skill:'沙海工事：部署后提高队伍防御。', faction:'边境工坊' },
    { code:'GC-011',sprite:2,sheet:3, name:'影域斥候', en:'SHADE SCOUT', rarity:'R', element:'暗', glyph:'◒', atk:41, def:19, skill:'暗影绕行：有机会规避一次攻击。', faction:'夜航旅团' },
    { code:'GC-012',sprite:3,sheet:3, name:'天穹导航官', en:'SKY NAVIGATOR', rarity:'SR', element:'风', glyph:'✧', atk:52, def:39, skill:'天穹导航：风元素队友攻击提高。', faction:'远航公会' },
    { code:'GC-013',sprite:0,sheet:4, name:'深海共鸣者', en:'ABYSS RESONATOR', rarity:'SR', element:'水', glyph:'◉', atk:45, def:53, skill:'深海共鸣：为队伍分摊一次重击。', faction:'深蓝议会' },
    { code:'GC-014',sprite:1,sheet:4, name:'赤曜守门人', en:'RUBY GATEKEEPER', rarity:'SR', element:'火', glyph:'⛨', atk:57, def:46, skill:'赤曜反击：受到攻击后返还部分伤害。', faction:'星环守望' },
    { code:'GC-015',sprite:2,sheet:4, name:'星桥织造师', en:'STARBRIDGE WEAVER', rarity:'SSR', element:'光', glyph:'✣', atk:72, def:61, skill:'星桥链接：相邻卡牌技能效果增强。', faction:'星环守望' },
    { code:'GC-016',sprite:3,sheet:4, name:'虚空档案官', en:'VOID ARCHIVIST', rarity:'SSR', element:'暗', glyph:'⟁', atk:79, def:55, skill:'虚空档案：复制一项已触发的队伍增益。', faction:'夜航旅团' },
    { code:'GC-017',sprite:0,sheet:5, name:'熵潮领航者', en:'ENTROPY PILOT', rarity:'SSR', element:'火', glyph:'⟡', atk:84, def:62, skill:'熵潮推进：队伍首次攻击造成连锁冲击。', faction:'深蓝议会' },
    { code:'GC-018',sprite:1,sheet:5, name:'星核铸造师', en:'NOVA FORGE', rarity:'UR', element:'火', glyph:'✷', atk:96, def:88, skill:'创世星核：平衡全队能量并强化元素协同。', faction:'创世议会' },
    { code:'GC-019',sprite:2,sheet:5, name:'熔金铸誓者', en:'GILDED OATHSMITH', rarity:'N', element:'火', glyph:'₿', atk:24, def:20, skill:'余烬铸币：首次进攻后获得少量护盾。', faction:'比特熔炉' },
    { code:'GC-020',sprite:3,sheet:5, name:'紫晶观星师', en:'AMETHYST ORACLE', rarity:'N', element:'光', glyph:'◇', atk:16, def:29, skill:'晶簇预言：揭示一项未知战场效果。', faction:'以太高庭' },
    { code:'GC-021',sprite:0,sheet:6, name:'金链狮卫', en:'GOLDCHAIN LIONGUARD', rarity:'N', element:'土', glyph:'◆', atk:27, def:25, skill:'链环壁垒：相邻友军获得防护。', faction:'金链王庭' },
    { code:'GC-022',sprite:1,sheet:6, name:'双彗巡游者', en:'TWIN COMET RUNNER', rarity:'N', element:'风', glyph:'≋', atk:29, def:19, skill:'彗尾疾驰：有机会抢先行动。', faction:'霓虹航线' },
    { code:'GC-023',sprite:2,sheet:6, name:'银潮龙骑', en:'SILVER TIDE RIDER', rarity:'R', element:'水', glyph:'✕', atk:39, def:35, skill:'潮汐回响：受到攻击时为队伍恢复耐久。', faction:'银潮联邦' },
    { code:'GC-024',sprite:3,sheet:6, name:'蓝穹织星者', en:'AZURE STARWEAVER', rarity:'R', element:'光', glyph:'◉', atk:36, def:40, skill:'星图连结：强化光元素队友的防御。', faction:'蓝穹学会' },
    { code:'GC-025',sprite:0,sheet:7, name:'金尾星狐', en:'GOLDFLARE FOX', rarity:'R', element:'火', glyph:'Ð', atk:43, def:29, skill:'幸运跃迁：闪避后反击一次。', faction:'彗星游乐团' },
    { code:'GC-026',sprite:1,sheet:7, name:'苍链裁决官', en:'COBALT LINKKEEPER', rarity:'SR', element:'风', glyph:'∞', atk:58, def:46, skill:'链式裁决：连续命中时追加连锁伤害。', faction:'蓝链守序庭' },
    { code:'GC-027',sprite:2,sheet:7, name:'赤雪狼将', en:'CRIMSON SNOW WOLF', rarity:'R', element:'冰', glyph:'▲', atk:47, def:37, skill:'冰原突袭：对受控目标造成额外冲击。', faction:'赤雪边军' },
    { code:'GC-028',sprite:3,sheet:7, name:'环轨舞姬', en:'ORBITAL DANCER', rarity:'SR', element:'光', glyph:'●', atk:55, def:51, skill:'轨道共振：每回合为随机友军充能。', faction:'环轨剧团' },
    { code:'GC-029',sprite:0,sheet:8, name:'虹棱解码师', en:'PRISM DECIPHERER', rarity:'SSR', element:'暗', glyph:'⌘', atk:78, def:68, skill:'棱镜重写：复制最近触发的队伍技能。', faction:'折光秘会' },
    { code:'GC-030',sprite:1,sheet:8, name:'翡翠锚卫', en:'EMERALD ANCHOR WARDEN', rarity:'UR', element:'木', glyph:'⬡', atk:88, def:98, skill:'恒锚庇护：抵消一次重击并稳定全队。', faction:'绿洲议会' },
    { code:'GC-031',sprite:0,sheet:1,sheetSet:'classic',name:'比特创世者',en:'GENESIS ARCHON',rarity:'UR',element:'火',glyph:'₿',atk:99,def:91,skill:'比特创世：为全队生成一次护盾并强化先手。',faction:'比特熔炉'},
    { code:'GC-032',sprite:1,sheet:1,sheetSet:'classic',name:'金链统御者',en:'GOLDEN SOVEREIGN',rarity:'UR',element:'土',glyph:'◆',atk:92,def:99,skill:'金链守护：抵消一次重击并提升全队防御。',faction:'金链王庭'},
    { code:'GC-033',sprite:2,sheet:1,sheetSet:'classic',name:'以太构筑师',en:'ETHER ARCHITECT',rarity:'SSR',element:'光',glyph:'◇',atk:84,def:76,skill:'以太构筑：强化全队技能并补充能量。',faction:'以太高庭'},
    { code:'GC-034',sprite:3,sheet:1,sheetSet:'classic',name:'神谕编织者',en:'ORACLE WEAVER',rarity:'SSR',element:'风',glyph:'∞',atk:81,def:73,skill:'神谕链接：复制一项已触发的队伍技能。',faction:'神谕网络'},
    { code:'GC-035',sprite:0,sheet:2,sheetSet:'classic',name:'彗星疾行者',en:'COMET SPRINTER',rarity:'SSR',element:'风',glyph:'≋',atk:88,def:70,skill:'彗星冲刺：连续攻击时追加一次连击。',faction:'霓虹航线'},
    { code:'GC-036',sprite:1,sheet:2,sheetSet:'classic',name:'账本守望者',en:'LEDGER SENTINEL',rarity:'SSR',element:'水',glyph:'✕',atk:76,def:85,skill:'账本回响：将一次重击分摊给全队。',faction:'账本守望'},
    { code:'GC-037',sprite:2,sheet:2,sheetSet:'classic',name:'纪元守护者',en:'EPOCH WARDEN',rarity:'SR',element:'光',glyph:'◉',atk:68,def:64,skill:'纪元庇护：为光元素队友增加护盾。',faction:'卡尔达诺议会'},
    { code:'GC-038',sprite:3,sheet:2,sheetSet:'classic',name:'减半骑士',en:'HALVING KNIGHT',rarity:'SR',element:'火',glyph:'₿',atk:70,def:60,skill:'减半之力：首次攻击后提升队伍攻击。',faction:'比特熔炉'},
    { code:'GC-039',sprite:0,sheet:3,sheetSet:'classic',name:'燃料信使',en:'FUEL COURIER',rarity:'SR',element:'光',glyph:'◇',atk:63,def:66,skill:'燃料传递：为下一位行动的队友充能。',faction:'以太高庭'},
    { code:'GC-040',sprite:1,sheet:3,sheetSet:'classic',name:'银光快递员',en:'SILVER COURIER',rarity:'SR',element:'风',glyph:'Ł',atk:66,def:58,skill:'银光速递：有机会抢先行动并闪避。',faction:'银光车队'},
    { code:'GC-041',sprite:2,sheet:3,sheetSet:'classic',name:'验证者队长',en:'VALIDATOR CAPTAIN',rarity:'SR',element:'土',glyph:'◆',atk:58,def:71,skill:'验证者阵列：提升全队防御并稳定阵形。',faction:'金链王庭'},
    { code:'GC-042',sprite:3,sheet:3,sheetSet:'classic',name:'月面信使',en:'MOON MESSENGER',rarity:'SR',element:'光',glyph:'Ð',atk:72,def:55,skill:'月面弹跳：闪避后快速反击一次。',faction:'彗星游乐团'},
    { code:'GC-043',sprite:0,sheet:4,sheetSet:'classic',name:'极速竞速者',en:'VELOCITY RACER',rarity:'SR',element:'风',glyph:'≋',atk:74,def:52,skill:'极速终点：命中后提升下一次攻击。',faction:'霓虹航线'},
    { code:'GC-044',sprite:1,sheet:4,sheetSet:'classic',name:'数据引路人',en:'DATA PATHFINDER',rarity:'R',element:'水',glyph:'∞',atk:62,def:69,skill:'数据寻路：揭示并压制一个危险目标。',faction:'神谕网络'},
    { code:'GC-045',sprite:2,sheet:4,sheetSet:'classic',name:'雪崩先锋',en:'AVALANCHE VANGUARD',rarity:'R',element:'冰',glyph:'▲',atk:55,def:52,skill:'雪崩突进：对受控目标造成额外冲击。',faction:'雪崩远征队'},
    { code:'GC-046',sprite:3,sheet:4,sheetSet:'classic',name:'中继织网者',en:'RELAY WEAVER',rarity:'R',element:'光',glyph:'●',atk:50,def:59,skill:'中继共鸣：强化相邻卡牌的元素效果。',faction:'中继议会'},
    { code:'GC-047',sprite:0,sheet:5,sheetSet:'classic',name:'并行领航员',en:'PARALLEL PILOT',rarity:'R',element:'风',glyph:'✧',atk:57,def:48,skill:'并行推进：队伍首次攻击追加连锁伤害。',faction:'并行舰队'},
    { code:'GC-048',sprite:1,sheet:5,sheetSet:'classic',name:'权益守卫',en:'STAKEKEEPER',rarity:'R',element:'土',glyph:'◉',atk:45,def:64,skill:'权益屏障：抵挡一次轻型冲击。',faction:'卡尔达诺议会'},
    { code:'GC-049',sprite:2,sheet:5,sheetSet:'classic',name:'轻链矿工',en:'LIGHTCHAIN MINER',rarity:'R',element:'土',glyph:'Ł',atk:53,def:51,skill:'轻链寻矿：探索时额外获得锻造素材。',faction:'银光车队'},
    { code:'GC-050',sprite:3,sheet:5,sheetSet:'classic',name:'跨链使者',en:'CROSS-LEDGER ENVOY',rarity:'R',element:'水',glyph:'✕',atk:48,def:60,skill:'跨账本协作：分摊队伍受到的一次伤害。',faction:'账本守望'},
    { code:'GC-051',sprite:0,sheet:6,sheetSet:'classic',name:'燃气守卫',en:'GAS GUARDIAN',rarity:'N',element:'土',glyph:'◆',atk:39,def:48,skill:'燃气护甲：部署后小幅提高全队防御。',faction:'金链王庭'},
    { code:'GC-052',sprite:1,sheet:6,sheetSet:'classic',name:'笑面旅者',en:'GRINNING WAYFARER',rarity:'N',element:'光',glyph:'Ð',atk:46,def:36,skill:'欢跃回击：闪避后有机会反击。',faction:'彗星游乐团'},
    { code:'GC-053',sprite:2,sheet:6,sheetSet:'classic',name:'日蚀滑行者',en:'ECLIPSE RIDER',rarity:'N',element:'风',glyph:'≋',atk:43,def:40,skill:'日蚀滑步：提升一次闪避几率。',faction:'霓虹航线'},
    { code:'GC-054',sprite:3,sheet:6,sheetSet:'classic',name:'节点驯兽师',en:'NODE TAMER',rarity:'N',element:'水',glyph:'∞',atk:37,def:49,skill:'节点协同：为随机队友恢复少量耐久。',faction:'神谕网络'},
    { code:'GC-055',sprite:0,sheet:7,sheetSet:'classic',name:'火山巡守者',en:'VOLCANIC SCOUT',rarity:'N',element:'火',glyph:'▲',atk:49,def:35,skill:'火山踏击：对标记目标造成额外伤害。',faction:'雪崩远征队'},
    { code:'GC-056',sprite:1,sheet:7,sheetSet:'classic',name:'星际摆渡员',en:'STARFERRY PILOT',rarity:'N',element:'光',glyph:'●',atk:41,def:44,skill:'星际摆渡：提升光元素队友的防御。',faction:'中继议会'},
    { code:'GC-057',sprite:2,sheet:7,sheetSet:'classic',name:'密钥收藏家',en:'KEYSTONE KEEPER',rarity:'N',element:'暗',glyph:'₿',atk:47,def:38,skill:'密钥守藏：首次受到攻击时获得护盾。',faction:'比特熔炉'},
    { code:'GC-058',sprite:3,sheet:7,sheetSet:'classic',name:'区块学徒',en:'BLOCK APPRENTICE',rarity:'N',element:'光',glyph:'◇',atk:35,def:50,skill:'区块记录：揭示一项未知战场效果。',faction:'以太高庭'},
    { code:'GC-059',sprite:0,sheet:8,sheetSet:'classic',name:'莱特巡游者',en:'LITEWAYFARER',rarity:'N',element:'风',glyph:'Ł',atk:44,def:39,skill:'莱特疾行：有机会抢先行动。',faction:'银光车队'},
    { code:'GC-060',sprite:1,sheet:8,sheetSet:'classic',name:'并行信标',en:'PARALLEL BEACON',rarity:'N',element:'暗',glyph:'✧',atk:40,def:45,skill:'并行信标：提升队伍下一次技能效果。',faction:'并行舰队'},
    { code:'GC-061',sprite:2,sheet:8,sheetSet:'classic',name:'闪电巡链员',en:'LIGHTNING PATHFINDER',rarity:'N',element:'风',glyph:'Ł',atk:42,def:39,skill:'闪电通道：队伍首次行动后提高闪避。',faction:'银光车队'},
    { code:'GC-062',sprite:3,sheet:8,sheetSet:'classic',name:'狗狗币信使',en:'DOGECOIN COURIER',rarity:'N',element:'光',glyph:'Ð',atk:45,def:37,skill:'迷因快递：闪避后为队友补充少量能量。',faction:'彗星游乐团'},
    { code:'GC-063',sprite:0,sheet:1,sheetSet:'classic',name:'以太燃气术士',en:'ETHER GAS SAGE',rarity:'N',element:'火',glyph:'◇',atk:39,def:46,skill:'燃气调度：登场时小幅提升队伍防御。',faction:'以太高庭'},
    { code:'GC-064',sprite:1,sheet:2,sheetSet:'classic',name:'BNB 节点学徒',en:'BNB NODE APPRENTICE',rarity:'R',element:'土',glyph:'◆',atk:48,def:53,skill:'节点协作：提升相邻队友的防御。',faction:'金链王庭'},
    { code:'GC-065',sprite:2,sheet:3,sheetSet:'classic',name:'比特闪电信使',en:'BITCOIN LIGHTNING RUNNER',rarity:'R',element:'风',glyph:'₿',atk:56,def:48,skill:'闪电结算：先手攻击命中后追加链式伤害。',faction:'比特熔炉'},
    { code:'GC-066',sprite:3,sheet:4,sheetSet:'classic',name:'索拉纳验证者',en:'SOLANA VALIDATOR',rarity:'R',element:'光',glyph:'≋',atk:51,def:57,skill:'高频共识：队伍行动后为随机队友充能。',faction:'远航公会'},
    { code:'GC-067',sprite:0,sheet:5,sheetSet:'classic',name:'莱特币银翼',en:'LITECOIN SILVERWING',rarity:'R',element:'水',glyph:'Ł',atk:54,def:55,skill:'银翼确认：受到攻击时恢复少量耐久。',faction:'银光车队'},
    { code:'GC-068',sprite:1,sheet:6,sheetSet:'classic',name:'比特减半守望者',en:'BITCOIN HALVING WARDEN',rarity:'SR',element:'火',glyph:'₿',atk:69,def:65,skill:'减半周期：首次攻击后提升全队攻击。',faction:'比特熔炉'},
    { code:'GC-069',sprite:2,sheet:7,sheetSet:'classic',name:'以太二层领航员',en:'ETHEREUM LAYER TWO GUIDE',rarity:'SR',element:'风',glyph:'◇',atk:66,def:70,skill:'二层跃迁：降低队伍受到的下一次伤害。',faction:'以太高庭'},
    { code:'GC-070',sprite:3,sheet:8,sheetSet:'classic',name:'瑞波账本裁决官',en:'XRP LEDGER ARBITER',rarity:'SR',element:'水',glyph:'✕',atk:72,def:63,skill:'账本终局：对已标记目标造成额外伤害。',faction:'账本守望'},
    { code:'GC-071',sprite:0,sheet:2,sheetSet:'classic',name:'BNB 金链龙骑',en:'BNB GOLDCHAIN DRAGOON',rarity:'SSR',element:'土',glyph:'◆',atk:82,def:79,skill:'金链共振：为全队生成护盾并强化节点属性队友。',faction:'金链王庭'},
    { code:'GC-072',sprite:1,sheet:4,sheetSet:'classic',name:'以太合约编织者',en:'ETH SMART CONTRACT WEAVER',rarity:'SSR',element:'光',glyph:'◇',atk:86,def:74,skill:'合约编织：复制一项队伍技能并强化其效果。',faction:'以太高庭'},
    { code:'GC-073',sprite:2,sheet:6,sheetSet:'classic',name:'比特链上先知',en:'BITCOIN ONCHAIN ORACLE',rarity:'SSR',element:'暗',glyph:'₿',atk:80,def:83,skill:'链上预言：揭示敌方行动并抵消一次重击。',faction:'比特熔炉'},
    { code:'GC-074',sprite:3,sheet:7,sheetSet:'classic',name:'中本聪·创世密钥',en:'SATOSHI · GENESIS KEY',rarity:'UR',element:'火',glyph:'₿',atk:100,def:96,skill:'创世密钥：为队伍抵挡一次重击，并强化下一次攻击。',faction:'比特熔炉'},
    { code:'GC-075',sprite:0,sheet:8,sheetSet:'classic',name:'以太创世使者',en:'ETHEREUM GENESIS HERALD',rarity:'UR',element:'光',glyph:'◇',atk:97,def:99,skill:'信标共识：抵消一次重击并恢复全队能量。',faction:'以太高庭'}
  ];
  const CRYPTO_MOTIFS = [
    { ticker:'BTC', name:'Bitcoin', nameZh:'比特币', mark:'₿', color:'#f7931a' },
    { ticker:'ETH', name:'Ether', nameZh:'以太币', network:'Ethereum', mark:'◇', color:'#a9a5ff' },
    { ticker:'BNB', name:'BNB', nameZh:'BNB', network:'BNB Chain', mark:'◆', color:'#f0b90b' },
    { ticker:'SOL', name:'Solana', nameZh:'索拉纳', mark:'≋', color:'#a879ff' },
    { ticker:'XRP', name:'XRP', nameZh:'XRP', network:'XRP Ledger', mark:'✕', color:'#9ab4ff' },
    { ticker:'ADA', name:'Ada', nameZh:'艾达币', network:'Cardano', mark:'◉', color:'#4ea7ff' },
    { ticker:'DOGE', name:'Dogecoin', nameZh:'狗狗币', mark:'Ð', color:'#c6a84a' },
    { ticker:'LINK', name:'Chainlink', nameZh:'Chainlink', mark:'∞', color:'#5d8cff' },
    { ticker:'AVAX', name:'Avalanche', nameZh:'雪崩协议', mark:'▲', color:'#ef5260' },
    { ticker:'DOT', name:'Polkadot', nameZh:'波卡', mark:'●', color:'#e6007a' },
    { ticker:'MON', name:'Monad', nameZh:'蒙纳德', mark:'✧', color:'#c3a9ff' },
    { ticker:'USDT', name:'Tether USDt', nameZh:'泰达币', network:'Tether', mark:'₮', color:'#53ae94' },
    { ticker:'LTC', name:'Litecoin', nameZh:'莱特币', mark:'Ł', color:'#aeb6bf' }
  ];
  const CARD_CRYPTO_MOTIF = Object.freeze({
    'GC-001':'BTC','GC-002':'ETH','GC-003':'BNB','GC-004':'SOL','GC-005':'XRP','GC-006':'DOGE',
    'GC-007':'ADA','GC-008':'LINK','GC-009':'AVAX','GC-010':'DOT','GC-011':'BTC','GC-012':'ETH',
    'GC-013':'BNB','GC-014':'SOL','GC-015':'XRP','GC-016':'ADA','GC-017':'LINK','GC-018':'BTC',
    'GC-019':'BTC','GC-020':'ETH','GC-021':'BNB','GC-022':'SOL','GC-023':'XRP','GC-024':'ADA',
    'GC-025':'DOGE','GC-026':'LINK','GC-027':'AVAX','GC-028':'DOT','GC-029':'MON','GC-030':'USDT',
    'GC-031':'BTC','GC-032':'BNB','GC-033':'ETH','GC-034':'LINK','GC-035':'SOL','GC-036':'XRP',
    'GC-037':'ADA','GC-038':'BTC','GC-039':'ETH','GC-040':'LTC','GC-041':'BNB','GC-042':'DOGE',
    'GC-043':'SOL','GC-044':'LINK','GC-045':'AVAX','GC-046':'DOT','GC-047':'MON','GC-048':'ADA',
    'GC-049':'LTC','GC-050':'XRP','GC-051':'BNB','GC-052':'DOGE','GC-053':'SOL','GC-054':'LINK',
    'GC-055':'AVAX','GC-056':'DOT','GC-057':'BTC','GC-058':'ETH','GC-059':'LTC','GC-060':'MON',
    'GC-061':'LTC','GC-062':'DOGE','GC-063':'ETH','GC-064':'BNB','GC-065':'BTC','GC-066':'SOL',
    'GC-067':'LTC','GC-068':'BTC','GC-069':'ETH','GC-070':'XRP','GC-071':'BNB','GC-072':'ETH',
    'GC-073':'BTC','GC-074':'BTC','GC-075':'ETH'
  });
  // Player-facing bilingual names and skill text. Keep the crypto motif in the
  // title, and make the card's role/ability read naturally in both languages.
  const CARD_COPY = Object.freeze({
    'GC-001':['链上矿工','Onchain Miner','哈希勘探','搜寻矿脉时，有机会发现额外的锻造材料。','Hashrate Survey','May find extra forging material while scouting a vein.'],
    'GC-002':['信标使者','Beacon Runner','区块快讯','提升队伍先手率，抢在对手前行动。','Block Beacon','Raises the squad’s chance to act first.'],
    'GC-003':['燃气护卫','Gas Warden','燃气护盾','为队伍抵挡一次轻型攻击。','Gas Shield','Blocks one light attack against the squad.'],
    'GC-004':['验证者工程师','Validator Engineer','节点维护','每回合为队伍恢复少量生命值。','Validator Uptime','Restores a small amount of squad health each turn.'],
    'GC-005':['跨链拾荒者','Cross-chain Scavenger','桥接寻宝','探索废墟时，有机会带回额外素材。','Bridge Salvage','May recover extra material while exploring ruins.'],
    'GC-006':['矿池点火员','Mining Pool Igniter','矿池增幅','提升火属性队友的攻击力。','Pool Boost','Raises the attack of allied Flame cards.'],
    'GC-007':['共识测绘员','Consensus Cartographer','链路扫描','提前标记下一段航路上的危险目标。','Route Scan','Marks a dangerous target on the next route in advance.'],
    'GC-008':['预言机标记者','Oracle Marker','价格预言','标记目标，使其受到的下一次攻击增强。','Oracle Mark','Marks a target to amplify the next hit it takes.'],
    'GC-009':['流动性驯潮师','Liquidity Tidemancer','流动性护航','为水属性队友提供一次伤害减免。','Liquidity Guard','Grants allied Tide cards one instance of damage reduction.'],
    'GC-010':['链上筑垒师','Onchain Bastion Engineer','节点防线','登场时提升全队防御。','Validator Bastion','Raises squad defense on deployment.'],
    'GC-011':['闪电网络斥候','Lightning Scout','快速通道','有机会避开一次来袭攻击。','Fast Channel','May evade one incoming attack.'],
    'GC-012':['质押导航官','Staking Navigator','质押增益','提升风属性队友的攻击力。','Staking Uplift','Raises the attack of allied Wind cards.'],
    'GC-013':['深海共识者','Deep Consensus Rider','共识分担','将一次重击的伤害分摊给全队。','Shared Consensus','Splits one heavy hit across the squad.'],
    'GC-014':['熔岩验证者','Magma Validator','区块反击','受到攻击后，对攻击者返还部分伤害。','Block Counter','Returns part of the damage to an attacker.'],
    'GC-015':['星桥织造师','Starweaver','跨链协同','强化相邻队友的技能效果。','Cross-chain Synergy','Strengthens the abilities of adjacent allies.'],
    'GC-016':['链上档案官','Onchain Archivist','状态复刻','复制一项已触发的队伍增益。','State Snapshot','Copies one squad boost that has already triggered.'],
    'GC-017':['区块熵潮领航者','Mempool Navigator','连续打包','队伍首次攻击后追加一次连锁冲击。','Block Sequence','Adds a chain impact after the squad’s first attack.'],
    'GC-018':['创世区块铸造师','Genesis Block Forger','创世共鸣','平衡全队能量，并强化元素协同。','Genesis Resonance','Balances squad energy and amplifies elemental synergy.'],
    'GC-019':['铸币师','Mintkeeper','余烬护盾','首次攻击后获得一层护盾。','Ember Shield','Gains one shield after the first attack.'],
    'GC-020':['链上预言者','Onchain Oracle','链上预警','揭示一项尚未公开的战场效果。','Onchain Forecast','Reveals one undisclosed battlefield effect.'],
    'GC-021':['金链节点狮卫','Golden Chain Nodeguard','节点壁垒','为相邻队友提供护盾。','Node Barrier','Shields adjacent allies.'],
    'GC-022':['双彗巡游者','Comet Runner','高速出块','有机会获得先手。','Rapid Finality','May gain the first move.'],
    'GC-023':['账本守护者','Ledger Guardian','账本回响','受到攻击时，为队伍恢复少量生命值。','Ledger Reprise','Restores a small amount of squad health when attacked.'],
    'GC-024':['星图织造者','Starweaver','共识星图','提升光属性队友的防御。','Consensus Chart','Raises defense for allied Light cards.'],
    'GC-025':['金尾星狐','Goldflare Fox','幸运回撤','闪避攻击后，反击一次。','Lucky Reversal','Counterattacks once after evading.'],
    'GC-026':['链式裁决官','Chainkeeper','预言连击','连续命中时追加链式伤害。','Oracle Chain','Adds chained damage on consecutive hits.'],
    'GC-027':['赤雪先锋','Frost Vanguard','雪崩清算','对受控目标造成额外伤害。','Avalanche Liquidation','Deals extra damage to a controlled target.'],
    'GC-028':['平行链共鸣者','Parachain Resonator','平行充能','每回合为一名随机队友充能。','Parachain Charge','Charges a random ally each turn.'],
    'GC-029':['棱镜解码师','Prism Decoder','状态重写','复制最近触发的一项队伍技能。','State Rewrite','Copies the most recently triggered squad ability.'],
    'GC-030':['稳定锚卫','Stability Warden','锚定防护','抵消一次重击，并稳住全队阵形。','Peg Stability','Negates one heavy hit and steadies the squad.'],
    'GC-031':['创世守护者','Genesis Warden','创世防线','为全队生成一次护盾，并提升首回合先手率。','Genesis Guard','Shields the squad once and raises its chance to act first.'],
    'GC-032':['金链统御者','Chain Sovereign','验证者壁垒','抵消一次重击，并提升全队防御。','Validator Bastion','Negates one heavy hit and raises squad defense.'],
    'GC-033':['合约构筑师','Contract Architect','合约增幅','强化全队技能，并恢复少量能量。','Contract Amplifier','Strengthens squad abilities and restores a little energy.'],
    'GC-034':['神谕编织者','Oracle Weaver','预言复制','复制一项已触发的队伍技能。','Oracle Copy','Copies one squad ability that has triggered.'],
    'GC-035':['彗星疾行者','Comet Sprinter','极速连击','连续攻击时追加一次连击。','Quickstrike Combo','Adds a combo strike during consecutive attacks.'],
    'GC-036':['账本守望者','Ledger Sentinel','账本共担','将一次重击分摊给全队。','Ledger Share','Shares one heavy hit across the squad.'],
    'GC-037':['纪元守护者','Epoch Warden','纪元护盾','为光属性队友提供护盾。','Epoch Shield','Shields allied Light cards.'],
    'GC-038':['减半骑士','Halving Knight','减半增幅','首次攻击后提升全队攻击力。','Halving Surge','Raises squad attack after the first strike.'],
    'GC-039':['燃料信使','Gas Courier','燃料传递','为下一位行动的队友补充能量。','Gas Transfer','Restores energy to the next ally to act.'],
    'GC-040':['银光快递员','Silver Courier','闪电速递','有机会先手行动并闪避一次攻击。','Lightning Dispatch','May act first and evade one attack.'],
    'GC-041':['验证者队长','Validator Captain','节点阵列','提升全队防御并稳固阵形。','Validator Formation','Raises squad defense and steadies its formation.'],
    'GC-042':['月面信使','Lunar Courier','弹性回击','闪避后快速反击一次。','Bounce Back','Quickly counterattacks after evading.'],
    'GC-043':['极速竞速者','Velocity Racer','高速确认','命中后提升下一次攻击。','Fast Confirmation','Raises the next attack after a hit.'],
    'GC-044':['数据引路人','Data Pathfinder','预言定位','揭示并削弱一个危险目标。','Oracle Lock','Reveals and weakens a dangerous target.'],
    'GC-045':['雪崩先锋','Avalanche Vanguard','雪崩突进','对受控目标造成额外伤害。','Avalanche Charge','Deals extra damage to a controlled target.'],
    'GC-046':['中继织网者','Relay Weaver','中继协同','强化相邻卡牌的元素效果。','Relay Synergy','Strengthens elemental effects of adjacent cards.'],
    'GC-047':['并行领航员','Parallel Pilot','并行执行','队伍首次攻击后追加链式伤害。','Parallel Execution','Adds chained damage after the squad’s first attack.'],
    'GC-048':['权益守卫','Stake Warden','权益护盾','抵挡一次轻型攻击。','Stake Shield','Blocks one light attack.'],
    'GC-049':['轻链矿工','Litecoin Miner','轻链寻矿','探索时额外获得锻造材料。','Litecoin Prospecting','Finds extra forging material during exploration.'],
    'GC-050':['跨账本使者','Cross-ledger Envoy','跨账本共担','替全队分摊一次伤害。','Cross-ledger Share','Shares one instance of damage across the squad.'],
    'GC-051':['燃气守卫','Gas Guardian','燃气护甲','登场时小幅提升全队防御。','Gas Armor','Slightly raises squad defense on deployment.'],
    'GC-052':['笑面旅者','Grinning Wayfarer','趣味反击','闪避后有机会反击。','Lucky Riposte','May counterattack after evading.'],
    'GC-053':['日蚀滑行者','Eclipse Rider','快速闪避','提高一次闪避攻击的几率。','Swift Evade','Raises the chance to evade one attack.'],
    'GC-054':['预言机信使','Oracle Courier','价格馈送','为一名随机队友恢复少量生命值。','Oracle Feed','Restores a little health to a random ally.'],
    'GC-055':['火山巡守者','Volcanic Scout','火山清算','对已标记目标造成额外伤害。','Volcanic Liquidation','Deals extra damage to a marked target.'],
    'GC-056':['星际摆渡员','Starferry Pilot','平行链护航','提升光属性队友的防御。','Parachain Guard','Raises defense for allied Light cards.'],
    'GC-057':['密钥收藏家','Keykeeper','密钥保险库','首次受到攻击时获得护盾。','Key Vault','Gains a shield when first attacked.'],
    'GC-058':['区块学徒','Block Apprentice','区块索引','揭示一项尚未公开的战场效果。','Block Index','Reveals one undisclosed battlefield effect.'],
    'GC-059':['巡游者','Wayfarer','轻链疾行','有机会抢先行动。','Litecoin Sprint','May gain the first move.'],
    'GC-060':['并行信标','Parallel Beacon','并行增幅','提升队伍下一次技能效果。','Parallel Boost','Boosts the squad’s next ability.'],
    'GC-061':['莱特闪电巡链员','Litecoin Lightning Pathfinder','闪电通道','队伍首次行动后提高闪避。','Lightning Channel','Raises the squad’s evasion after its first move.'],
    'GC-062':['狗狗币信使','Dogecoin Courier','迷因快递','闪避后为队友补充少量能量。','Meme Dispatch','Restores a little energy to an ally after evading.'],
    'GC-063':['以太燃气术士','Ether Gas Sage','燃气调度','登场时小幅提升队伍防御。','Gas Routing','Slightly raises squad defense on deployment.'],
    'GC-064':['BNB 节点学徒','BNB Node Apprentice','节点协作','提升相邻队友的防御。','Node Assist','Raises the defense of adjacent allies.'],
    'GC-065':['比特闪电信使','Bitcoin Lightning Runner','闪电结算','先手攻击命中后追加链式伤害。','Lightning Settlement','Adds chained damage when the opening strike lands.'],
    'GC-066':['索拉纳验证者','Solana Validator','高频共识','队伍行动后为随机队友充能。','Fast Consensus','Charges a random ally after the squad acts.'],
    'GC-067':['莱特币银翼','Litecoin Silverwing','银翼确认','受到攻击时恢复少量耐久。','Silver Confirmation','Restores a little durability when attacked.'],
    'GC-068':['比特减半守望者','Bitcoin Halving Warden','减半周期','首次攻击后提升全队攻击。','Halving Cycle','Raises squad attack after the first strike.'],
    'GC-069':['以太二层领航员','Ethereum Layer Two Guide','二层跃迁','降低队伍受到的下一次伤害。','Layer Two Shift','Reduces the next damage taken by the squad.'],
    'GC-070':['瑞波账本裁决官','XRP Ledger Arbiter','账本终局','对已标记目标造成额外伤害。','Ledger Verdict','Deals extra damage to a marked target.'],
    'GC-071':['BNB 金链龙骑','BNB Golden Chain Dragoon','金链共振','为全队生成护盾并强化节点属性队友。','Golden Chain Resonance','Shields the squad and strengthens allied Node cards.'],
    'GC-072':['以太合约编织者','Ethereum Contract Weaver','合约编织','复制一项队伍技能并强化其效果。','Contract Weave','Copies a squad ability and strengthens its effect.'],
    'GC-073':['比特链上先知','Bitcoin Onchain Oracle','链上预言','揭示敌方行动并抵消一次重击。','Onchain Oracle','Reveals an enemy move and negates one heavy strike.'],
    'GC-074':['中本聪','Satoshi Nakamoto','创世密钥','为队伍抵挡一次重击，并强化下一次攻击。','Genesis Key','Blocks one heavy strike and strengthens the squad’s next attack.'],
    'GC-075':['以太创世使者','Ethereum Genesis Herald','信标共识','抵消一次重击并恢复全队能量。','Beacon Consensus','Negates one heavy strike and restores squad energy.']
  });
  const PACKS = [
    { id:'starter', name:'First Spark', nameZh:'初火', en:'FIRST SPARK', price:PACK_PRICE_USDT.starter, count:1, batchSize:800, rarityCounts:{N:560,R:192,SR:44,SSR:2,UR:2}, color:'#63cdb7' },
    { id:'bronze', name:'Frontier Kit', nameZh:'前线补给', en:'FRONTIER KIT', price:PACK_PRICE_USDT.bronze, count:3, batchSize:600, rarityCounts:{N:360,R:150,SR:72,SSR:15,UR:3}, color:'#cd8c5a' },
    { id:'gold', name:'Star Forge', nameZh:'星铸', en:'STAR FORGE', price:PACK_PRICE_USDT.gold, count:8, batchSize:400, rarityCounts:{N:180,R:120,SR:73,SSR:24,UR:3}, color:'#f0b90b' },
    { id:'genesis', name:'Genesis Vault', nameZh:'创世宝库', en:'GENESIS VAULT', price:PACK_PRICE_USDT.genesis, count:15, batchSize:1500, rarityCounts:{N:420,R:450,SR:522,SSR:100,UR:8}, color:'#b88cff' }
  ];
  const NEXT_RARITY = { N:'R', R:'SR', SR:'SSR', SSR:'UR' };
  const MARKET_SEED = [
    { id:'mkt-001',code:'GC-008',price:4.8,seller:'Wayfarer #018',listed:'12 min ago' },
    { id:'mkt-002',code:'GC-013',price:12,seller:'Halo Visitor #072',listed:'28 min ago' },
    { id:'mkt-003',code:'GC-015',price:31.5,seller:'Drifter #204',listed:'1 hr ago' },
    { id:'mkt-004',code:'GC-011',price:6.2,seller:'Deepwatch #091',listed:'2 hrs ago' },
    { id:'mkt-005',code:'GC-017',price:64,seller:'Drifter #156',listed:'4 hrs ago' },
    { id:'mkt-006',code:'GC-004',price:1.6,seller:'Frontier Forge #033',listed:'Today' },
    { id:'mkt-007',code:'GC-012',price:15.8,seller:'Star Cartographer #128',listed:'Today' },
    { id:'mkt-008',code:'GC-016',price:43,seller:'Nightflight #067',listed:'Today' },
    { id:'mkt-009',code:'GC-006',price:2.4,seller:'First Spark #042',listed:'Today' },
    { id:'mkt-010',code:'GC-018',price:188,seller:'Genesis Archive #001',listed:'Today' }
  ];

  const cardByCode = new Map(CARDS.map(card => [card.code, card]));
  const rarityById = new Map(RARITIES.map(rarity => [rarity.id, rarity]));
  const ELEMENT_EN = Object.freeze({土:'Earth',风:'Wind',光:'Light',水:'Tide',暗:'Void',火:'Flame',冰:'Frost',木:'Verdant'});
  const FACTION_EN = Object.freeze({
    '边境工坊':'Frontier Foundry','远航公会':'Wayfarer Guild','星环守望':'Halo Watch','深蓝议会':'Abyssal Conclave','夜航旅团':'Nightflight Crew','创世议会':'Genesis Council',
    '比特熔炉':'Bitcoin Crucible','以太高庭':'Ethereum Court','金链王庭':'Golden Chain Court','霓虹航线':'Neon Route','银潮联邦':'Silver Tide Federation','蓝穹学会':'Azure Observatory',
    '彗星游乐团':'Comet Carnival','蓝链守序庭':'Cobalt Order','赤雪边军':'Crimson Snow Guard','环轨剧团':'Orbital Theatre','折光秘会':'Prismatic Circle','绿洲议会':'Oasis Assembly',
    '神谕网络':'Oracle Network','账本守望':'Ledger Watch','卡尔达诺议会':'Cardano Council','银光车队':'Silverlight Convoy','雪崩远征队':'Avalanche Expedition','中继议会':'Relay Council','并行舰队':'Parallel Fleet'
  });
  const SKILL_EN = Object.freeze({
    'GC-001':['Vein Sense','Find basic crystal more easily during exploration.'],'GC-002':['Rapid Dispatch','Gives your squad the first move.'],'GC-003':['Glimmer Ward','Blocks one light impact.'],'GC-004':['Tundra Mend','Slowly restores squad durability.'],'GC-005':['Rift Salvage','Recovers extra materials from ruins.'],'GC-006':['Everflame','Slightly boosts allied Flame cards.'],
    'GC-007':['Echo Trace','Reveals a hazard along the next route.'],'GC-008':['Lattice Mark','Deals extra damage to a marked target.'],'GC-009':['Tidal Chorus','Grants a ward to allied Tide cards.'],'GC-010':['Dune Bastion','Raises squad defense on deployment.'],'GC-011':['Shade Step','May evade one incoming attack.'],'GC-012':['Skyward Guidance','Raises attack for allied Wind cards.'],
    'GC-013':['Abyssal Resonance','Shares the impact of one heavy strike.'],'GC-014':['Ruby Riposte','Returns part of damage after being hit.'],'GC-015':['Starbridge Link','Strengthens adjacent card abilities.'],'GC-016':['Void Archive','Copies one triggered squad boost.'],'GC-017':['Entropy Drive','Adds a chain impact to the squad’s first attack.'],'GC-018':['Genesis Core','Balances team energy and amplifies elemental synergy.'],
    'GC-019':['Ember Mint','Gain a small shield after your first attack.'],'GC-020':['Crystal Omen','Reveals one unknown battlefield effect.'],'GC-021':['Chainwall','Shields adjacent allies.'],'GC-022':['Comet Sprint','May claim the first move.'],'GC-023':['Tide Reprise','Restores squad durability when attacked.'],'GC-024':['Star Chart Link','Strengthens defense for allied Light cards.'],
    'GC-025':['Fortune Shift','Counterattacks once after evading.'],'GC-026':['Chain Verdict','Adds chain damage on consecutive hits.'],'GC-027':['Frostline Ambush','Deals extra impact to a controlled target.'],'GC-028':['Orbital Resonance','Charges a random ally each turn.'],'GC-029':['Prism Rewrite','Copies the latest triggered squad ability.'],'GC-030':['Evergreen Anchor','Negates one heavy strike and stabilizes the squad.'],
    'GC-031':['Genesis Shield','Shields the squad once and boosts its opening move.'],'GC-032':['Golden Guard','Negates one heavy strike and raises squad defense.'],'GC-033':['Ether Architecture','Strengthens squad abilities and restores energy.'],'GC-034':['Oracle Link','Copies one triggered squad ability.'],'GC-035':['Comet Rush','Adds a combo strike during consecutive attacks.'],'GC-036':['Ledger Echo','Shares one heavy strike across the squad.'],
    'GC-037':['Epoch Ward','Shields allied Light cards.'],'GC-038':['Halving Force','Raises squad attack after the first strike.'],'GC-039':['Fuel Transfer','Charges the next ally to act.'],'GC-040':['Silver Dispatch','May act first and evade an attack.'],'GC-041':['Validator Formation','Raises squad defense and steadies its formation.'],'GC-042':['Lunar Bounce','Quickly counterattacks after evading.'],'GC-043':['Velocity Finish','Raises the next attack after a hit.'],
    'GC-044':['Data Path','Reveals and suppresses a dangerous target.'],'GC-045':['Avalanche Charge','Deals extra impact to a controlled target.'],'GC-046':['Relay Resonance','Strengthens the elemental effects of adjacent cards.'],'GC-047':['Parallel Drive','Adds chain damage to the squad’s first attack.'],'GC-048':['Stake Ward','Blocks one light impact.'],'GC-049':['Lightchain Salvage','Finds extra forging materials during exploration.'],'GC-050':['Cross-Ledger Pact','Shares one instance of squad damage.'],
    'GC-051':['Gas Armor','Slightly raises squad defense on deployment.'],'GC-052':['Joyful Riposte','May counterattack after evading.'],'GC-053':['Eclipse Step','Improves the chance to evade one attack.'],'GC-054':['Node Harmony','Slightly restores a random ally’s durability.'],'GC-055':['Volcanic Impact','Deals extra damage to a marked target.'],'GC-056':['Starferry Guard','Raises defense for allied Light cards.'],'GC-057':['Keystone Cache','Gains a shield when first attacked.'],'GC-058':['Block Record','Reveals one unknown battlefield effect.'],'GC-059':['Lite Sprint','May claim the first move.'],'GC-060':['Parallel Signal','Boosts the squad’s next ability.']
  });
  const cardTitle = card => {
    const copy = CARD_COPY[card?.code];
    const motif = CRYPTO_MOTIFS.find(item => item.ticker === CARD_CRYPTO_MOTIF[card?.code]);
    const nickname = language === 'zh' ? (copy?.[0] || card?.name || '创世卡牌') : (copy?.[1] || card?.en || card?.code || 'Genesis Card');
    return motif ? `${language === 'zh' ? motif.nameZh : motif.name} · ${nickname}` : nickname;
  };
  const elementTitle = value => language === 'zh' ? (value || '未知') : (ELEMENT_EN[value] || value || 'Unknown');
  const factionTitle = value => language === 'zh' ? (value || '创世') : (FACTION_EN[value] || value || 'Genesis');
  const skillCopy = card => {
    const copy = CARD_COPY[card?.code];
    return copy ? (language === 'zh' ? [copy[2],copy[3]] : [copy[4],copy[5]]) : (language === 'zh' ? (card?.skill?.split('：') || ['卡牌技能','原创技能']) : (SKILL_EN[card?.code] || ['Genesis Ability','An original ability from the Crypto Genesis set.']));
  };
  const rarityName = rarity => language === 'zh' ? (rarity?.labelZh || rarity?.label || '') : (rarity?.label || '');
  const packName = pack => language === 'zh' ? (pack?.nameZh || pack?.name || '') : String(pack?.en || pack?.name || '').replace(/\b[a-z]/g,letter=>letter.toUpperCase());
  const ZH_TEXT = new Map(Object.entries({
    'Main navigation':'主导航','BNB CHAIN · CRYPTO GENESIS':'BNB 链 · 加密创世纪','Language':'语言','Discover':'发现','Card Packs':'卡包','Card Archive':'卡牌图鉴','Forge':'锻造','Trading Market':'交易市场','Arena':'竞技场','LOCAL DEMO':'本地演示','Collection':'卡册','Open menu':'打开菜单',
    'ORIGINAL TCG CARD SET':'原创 TCG 卡牌','Explore packs':'浏览卡包','View the archive':'查看图鉴','Cards':'卡牌','Rarity tiers':'稀有度','Pack tiers':'卡包档位','THE FIRST SIGNAL':'初始信号','CRYPTO ROOTS':'加密起源','Crypto Genesis motifs: Bitcoin, Ethereum and BNB Chain':'加密元素：比特币、以太币与 BNB Chain','Crypto':'加密','Genesis':'创世纪','GENESIS':'创世','S01 · GENESIS':'第 01 赛季 · 创世',
    'Choose a pack tier':'选择卡包档位','All':'全部','Collected':'已收集','Search name, ID or element':'搜索名称、编号或属性','3 × same card':'3 张相同卡牌','1 × next tier':'1 张高一级卡牌','Select cards':'选择卡牌','Select 3 cards':'选择 3 张卡牌','Sell':'出售','Market':'交易市场','VOLUME':'成交额','All tiers':'全部等级','Sort by price':'按价格排序','Featured':'推荐','Price: low to high':'价格从低到高','Price: high to low':'价格从高到低','My Collection':'我的卡册','Sealed packs':'未开启卡包','Opening history':'开包记录','Activity':'动态','Reset local demo':'重置本地演示','Close':'关闭','Sell a card':'出售卡牌','Card':'卡牌','Price':'价格','List':'挂单','Whitepaper':'白皮书','Load demo':'载入演示数据',
    'DEMO BALANCE':'演示余额','QUANTITY':'数量','Get pack':'开包','Sold out':'已售罄','Insufficient balance':'余额不足','BATCH':'批次','LEFT':'剩余','Common':'普通','Rare':'稀有','Super Rare':'超稀有','Epic':'史诗','Legendary':'传说','No cards match this search.':'没有符合条件的卡牌。','No cards':'暂无卡牌','No listings':'暂无挂单','No packs':'暂无卡包','No openings':'暂无开包记录','No activity':'暂无动态','SQUAD POWER':'队伍战力','Whitepaper':'白皮书','Opening history':'开包记录','CURRENT BATCH':'当前批次',
    'Selected':'已选择','Cards':'张卡牌','Demo balance':'演示余额','Unique':'不同卡牌','card':'张卡','cards':'张卡','Open':'开启','Remove':'移除','Add to squad':'编入队伍','Select card':'选择卡牌','Squad':'队伍','Enemy':'敌方','Void Echo':'虚空回响','SQUAD POWER':'队伍战力','Battle':'开始战斗','CLEARED':'胜利','DEFEATED':'失败','Elements':'属性','Faction':'阵营','CURRENT BATCH':'当前批次','BATCH':'批次','LEFT':'剩余',
    'GENESIS':'创世','GENESIS VAULT':'创世宝库','FIRST SPARK':'初火','FRONTIER KIT':'前线补给','STAR FORGE':'星铸','SEASON 01':'第 01 赛季','ORIGINAL CARD SET':'原创卡牌','CRYPTO GENESIS':'加密创世纪','BAI · GENESIS':'BAI · 创世','BAI TCG · CRYPTO GENESIS':'BAI TCG · 加密创世纪','CARD 018 / 075':'卡牌 018 / 075','BITCOIN':'比特币','BITCOIN · FIRE ELEMENT':'比特币 · 火属性','NOVA FORGE':'新星铸造','ETHER':'以太币','ETHEREUM':'以太坊','BNB CHAIN':'BNB Chain','FIRE ELEMENT':'火属性','GENESIS SSS':'创世 SSS','THE FIRST SIGNAL':'初始信号','Rarity':'稀有度','Legendary':'传说','JUST NOW':'刚刚','Just now':'刚刚','Buy':'购买','Sell':'出售','＋ Sell':'＋ 出售','Remove ×':'移出队伍 ×','Opening…':'开包中…','Pack opened':'卡包已开启','GENESIS PACK':'创世卡包','SEALED · SEASON 01':'已封装 · 第 01 赛季','Battle':'开始战斗','Open':'开启','Select card':'选择卡牌','Select 3 cards.':'请选择 3 张卡牌。','LOCAL DEMO':'本地演示','BNB CHAIN · CRYPTO GENESIS':'BNB 链 · 加密创世纪',
    'Reset demo?':'确定重置本地演示吗？','Demo loaded.':'演示数据已载入。','Reset.':'已重置。','Purchased.':'购买成功。','Listed.':'已挂单。','Sold':'已出售','No cards to sell.':'暂无可出售的卡牌。','Check card and price.':'请检查卡牌和价格。','Select 3 identical cards.':'请选择 3 张相同卡牌。','SSS is the top tier.':'SSS 已是最高等级。','Choose up to three forge materials.':'最多选择 3 张锻造材料。','Batch sold out.':'本批次已售罄。','Pack opened':'已开包','Card forge':'卡牌锻造','PVE simulation':'PVE 模拟','Demo market':'演示交易市场','Demo listing':'演示挂单','Sealed pack':'未开启卡包','Demo collection':'演示卡册'
  }));
  for (const card of CARDS) {
    const motif=CRYPTO_MOTIFS.find(item=>item.ticker===CARD_CRYPTO_MOTIF[card.code]);
    if (motif) {
      const nickname=String(card.en).toLowerCase().replace(/\b[a-z]/g,letter=>letter.toUpperCase());
      ZH_TEXT.set(`${motif.name} · ${nickname}`,`${motif.nameZh} · ${card.name}`);
    }
  }
  const originalText = new WeakMap(), originalAttrs = new WeakMap();
  function translateText(value) {
    if (language === 'en') return value;
    const trimmed = value.trim();
    if (ZH_TEXT.has(trimmed)) return value.replace(trimmed, ZH_TEXT.get(trimmed));
    let match = trimmed.match(/^Selected (\d+) \/ 3$/); if (match) return value.replace(trimmed, `已选 ${match[1]} / 3`);
    match = trimmed.match(/^(\d+) \/ 75$/); if (match) return value.replace(trimmed, `${match[1]} / 75`);
    match = trimmed.match(/^(\d+) cards?$/); if (match) return value.replace(trimmed, `${match[1]} 张卡牌`);
    match = trimmed.match(/^BATCH S01 · (\d+) LEFT$/); if (match) return value.replace(trimmed, `批次 S01 · 剩余 ${match[1]}`);
    let result=trimmed;
    for(const [en,zh] of ZH_TEXT) if(result.includes(en)) result=result.split(en).join(zh);
    match=result.match(/^Opened (.+) · (\d+) cards$/); if(match) result=`已开启 ${match[1]} · ${match[2]} 张卡牌`;
    match=result.match(/^Loaded (\d+) demo cards and ([\d,.]+) Demo USDT$/); if(match) result=`已载入 ${match[1]} 张演示卡牌和 ${match[2]} 演示 USDT`;
    match=result.match(/^Forged (.+) ×3 → (.+)$/); if(match) result=`锻造：${match[1]} ×3 → ${match[2]}`;
    match=result.match(/^(Bought|Sold|Listed) (.+) · ([\d,.]+) USDT$/); if(match) result=`${({Bought:'已购买',Sold:'已出售',Listed:'已挂单'})[match[1]]} ${match[2]} · ${match[3]} USDT`;
    return value.replace(trimmed,result);
  }
  function localizeNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE || node.parentElement?.closest('script,style,canvas')) return;
    if (!originalText.has(node)) originalText.set(node,node.nodeValue);
    const source = originalText.get(node), next = language === 'en' ? source : translateText(source);
    if (node.nodeValue !== next) node.nodeValue = next;
  }
  function localizeTree(root=document.body) {
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); let node;
    while(node=walker.nextNode()) localizeNode(node);
    const attrs=[...(root.matches?.('[placeholder],[aria-label],[title]')?[root]:[]),...(root.querySelectorAll?.('[placeholder],[aria-label],[title]')||[])];
    attrs.forEach(element=>{
      if(!originalAttrs.has(element)) originalAttrs.set(element,{});
      const saved=originalAttrs.get(element);
      for(const attr of ['placeholder','aria-label','title']) if(element.hasAttribute(attr)) {
        saved[attr] ??= element.getAttribute(attr);
        const source=saved[attr], next=language==='en'?source:translateText(source);
        if(element.getAttribute(attr)!==next) element.setAttribute(attr,next);
      }
    });
  }
  function setLanguage(next) {
    language=next==='en'?'en':'zh';
    try { localStorage.setItem(LANG_KEY,language); } catch {}
    document.documentElement.lang=language==='en'?'en':'zh-CN';
    document.title=language==='en'?'BAI TCG · Crypto Genesis':'BAI TCG · 加密创世纪';
    document.querySelector('meta[name="description"]')?.setAttribute('content',language==='en'?'BAI TCG: Crypto Genesis — an original cyberpunk trading card demo with sealed packs, collectible cards, fusion, and a simulated player market.':'BAI TCG：加密创世纪原创卡牌演示，包含卡包、卡牌收藏、合成、模拟交易与竞技。');
    el('lang-zh')?.classList.toggle('active',language==='zh'); el('lang-en')?.classList.toggle('active',language==='en');
    el('lang-zh')?.setAttribute('aria-pressed',String(language==='zh')); el('lang-en')?.setAttribute('aria-pressed',String(language==='en'));
    render(); localizeTree();
  }
  const el = id => document.getElementById(id);
  let toastTimer;
  let packRevealTimer = null;
  let activePack = null;
  let selectedPackId = 'gold';
  let packQuantity = 1;
  let selectedFusion = new Set();
  let catalogRarity = 'all';
  let marketRarity = 'all';
  let catalogQuery = '';
  let marketSort = 'featured';

  function freshState() {
    return { cardSetVersion:CARD_SET_VERSION, usdt:120, inventory:[], sealedPacks:[], packHistory:[], activity:[], market:MARKET_SEED.map(item => ({...item})), deck:[], marketVolume:1284.5, marketplaceFeePool:0, batchPools:createBatchPools() };
  }
  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (raw && typeof raw.usdt === 'number' && Array.isArray(raw.inventory) && Array.isArray(raw.market)) {
        const validPools = raw.batchPools && PACKS.every(pack=>Array.isArray(raw.batchPools[pack.id]));
        const batchPools = validPools ? raw.batchPools : createBatchPools();
        if (validPools && raw.cardSetVersion !== CARD_SET_VERSION) {
          for (const pool of Object.values(batchPools)) for (const rarity of RARITIES) {
            const templates = CARDS.filter(card=>card.rarity===rarity.id);
            const slots = pool.filter(asset=>asset.rarity===rarity.id);
            slots.forEach((asset,index)=>{ asset.code=templates[index % templates.length].code; });
          }
        }
        return {...raw, cardSetVersion:CARD_SET_VERSION, sealedPacks:Array.isArray(raw.sealedPacks)?raw.sealedPacks:[], batchPools};
      }
    } catch {}
    return freshState();
  }
  let state = loadState();
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} }
  function formatMoney(value) { return Number(value).toFixed(2); }
  function toCents(value) {
    const cents = Math.round(Number(value) * 100);
    return Number.isSafeInteger(cents) ? cents : null;
  }
  function packPrice(pack) {
    return pack.price;
  }
  function toast(message) {
    el('toast').textContent = language==='zh' ? translateText(message) : message;
    el('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el('toast').classList.remove('show'), 2400);
  }
  function randomInt(max) {
    if (max <= 1) return 0;
    const range = 0x100000000;
    const limit = range - (range % max);
    const values = new Uint32Array(1);
    do { crypto.getRandomValues(values); } while (values[0] >= limit);
    return values[0] % max;
  }
  function createBatchPools() {
    const pools = {};
    for (const pack of PACKS) {
      let serial = 0;
      const assets = [];
      for (const rarity of RARITIES) {
        const templates = CARDS.filter(card => card.rarity === rarity.id);
        for (let i=0; i<pack.rarityCounts[rarity.id]; i++) {
          const template = templates[i % templates.length];
          assets.push({ assetId:`${BATCH_ID}-${pack.id.toUpperCase()}-${String(++serial).padStart(4,'0')}`, code:template.code, rarity:rarity.id });
        }
      }
      for (let i=assets.length-1; i>0; i--) { const j=randomInt(i+1); [assets[i],assets[j]]=[assets[j],assets[i]]; }
      pools[pack.id] = assets;
    }
    return pools;
  }
  function createOwnedCard(code, assetId = null) {
    return { id:assetId || `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`, code, assetId, acquiredAt:new Date().toISOString(), assetState:assetId?'Season 01 · numbered demo edition':'Demo collectible' };
  }
  function availablePacks(pack) {
    return Math.floor((state.batchPools?.[pack.id]?.length || 0) / pack.count);
  }
  function reserveBatchAssets(pack, count) {
    const pool = state.batchPools?.[pack.id];
    if (!Array.isArray(pool) || pool.length < count) return null;
    const reserved = [];
    for (let i=0; i<count; i++) reserved.push(pool.splice(randomInt(pool.length),1)[0]);
    return reserved;
  }
  function currentOdds(pack) {
    const pool = state.batchPools?.[pack.id] || [];
    const total = pool.length;
    return RARITIES.map(rarity => ({...rarity, odds:total ? pool.filter(asset=>asset.rarity===rarity.id).length/total*100 : 0}));
  }
  function probabilityAtLeastOne(pack, rarityIds) {
    const pool = state.batchPools?.[pack.id] || [];
    const draws = Math.min(pack.count, pool.length);
    const matches = pool.filter(asset => rarityIds.includes(asset.rarity)).length;
    if (!draws || !matches) return 0;
    let probabilityNone = 1;
    for (let index = 0; index < draws; index++) {
      if (pool.length - matches - index <= 0) return 100;
      probabilityNone *= (pool.length - matches - index) / (pool.length - index);
    }
    return (1 - probabilityNone) * 100;
  }
  function probabilityAllOf(pack, rarityId) {
    const pool = state.batchPools?.[pack.id] || [];
    const draws = Math.min(pack.count, pool.length);
    const matches = pool.filter(asset => asset.rarity === rarityId).length;
    if (!draws || matches < draws) return 0;
    let probability = 1;
    for (let index = 0; index < draws; index++) probability *= (matches - index) / (pool.length - index);
    return probability * 100;
  }
  function formatOdds(value) { return value > 0 && value < 0.01 ? '<0.01%' : `${value.toFixed(2)}%`; }
  function rarityClass(rarity) { return `r-${rarity}`; }
  function rarityGrade(rarity) { return rarityById.get(rarity)?.grade || rarity; }
  function escapeHtml(input) { return String(input).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
  function cardMarkup(card, options = {}) {
    const ownedCount = options.count ?? null;
    const base = cardByCode.get(card.code) || card;
    if (!base) return '';
    const rarity = rarityById.get(base.rarity);
    const crypto = CRYPTO_MOTIFS.find(item => item.ticker === CARD_CRYPTO_MOTIF[base.code]);
    const [skillName, skillDescription] = skillCopy(base);
    const displayName = cardTitle(base);
    return `<article class="tcg-card ${rarityClass(base.rarity)}" title="${escapeHtml(displayName)} · ${escapeHtml(rarityName(rarity) || base.rarity)} · ${escapeHtml(elementTitle(base.element))}">
      <div class="tcg-card-inner"><div class="tcg-card-head"><b>${escapeHtml(displayName)}</b><span class="rarity-badge">${escapeHtml(rarityGrade(base.rarity))} <i>·</i> ${escapeHtml(rarityName(rarity) || base.rarity)}</span></div>
      <div class="tcg-card-meta"><span>${escapeHtml(elementTitle(base.element))} <i>·</i> ${escapeHtml(factionTitle(base.faction))}</span><span>${escapeHtml(base.code)}</span></div>
      <div class="tcg-card-art ${base.sheet !== undefined || base.art?'has-illustration':''}">${base.sheet !== undefined?`<span class="tcg-card-sprite ${base.sheetSet==='classic'?'classic-sheet ':''}sheet-${String(base.sheet).padStart(2,'0')} ${base.sprite >= 2 ? 'sprite-row-bottom' : 'sprite-row-top'}" role="img" aria-label="${escapeHtml(displayName)} collectible art" style="--sprite-x:${(base.sprite%2)*100}%"></span>`:base.art?`<img class="tcg-card-image" src="${escapeHtml(base.art)}" alt="${escapeHtml(displayName)} collectible art" loading="lazy" decoding="async">`:`<span class="character-icon">${base.glyph}</span>`}<span class="crypto-crest" style="--crypto-color:${crypto?.color || '#f0b90b'}" title="${escapeHtml([crypto?.name, crypto?.ticker, crypto?.network].filter(Boolean).join(' · ') || 'Crypto')}" aria-label="${escapeHtml(crypto?.name || 'Crypto')} motif"><b>${escapeHtml(crypto?.mark || '◇')}</b><small>${escapeHtml(crypto?.ticker || 'CRYPTO')}</small></span><span class="element-glyph">${escapeHtml(elementTitle(base.element))}</span><span class="nft-edition">${card.assetId?escapeHtml(card.assetId):'S01 · GENESIS'}</span></div>
      <div class="tcg-card-skill"><span>${escapeHtml(skillName)}</span><p>${escapeHtml(skillDescription)}</p></div>
      <div class="tcg-card-stats"><span>ATK <b>${base.atk}</b></span><span>DEF <b>${base.def}</b></span></div></div>
      ${ownedCount ? `<span class="owned-count">×${ownedCount}</span>` : ''}<span class="sr-only">${escapeHtml(rarityGrade(base.rarity))} · ${escapeHtml(rarityName(rarity) || base.rarity)} · ${escapeHtml(skillName)}: ${escapeHtml(skillDescription)}</span></article>`;
  }
  function inventoryCounts() {
    const counts = new Map();
    for (const owned of state.inventory) counts.set(owned.code, (counts.get(owned.code) || 0) + 1);
    return counts;
  }
  function addActivity(text, type = 'System') {
    state.activity.unshift({text, type, at:new Date().toLocaleString('en-US',{hour:'2-digit',minute:'2-digit'})});
    state.activity = state.activity.slice(0, 25);
  }
  function switchView(view) {
    if (!el(`view-${view}`)) return;
    closeOpenDialogs();
    document.querySelectorAll('[data-view-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.viewPanel === view));
    document.querySelectorAll('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    document.querySelector('.main-nav').classList.remove('open');
    window.scrollTo({top:0,behavior:'smooth'});
    render();
  }
  function closeOpenDialogs() {
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    if (packRevealTimer) { clearTimeout(packRevealTimer); packRevealTimer = null; }
    activePack = null;
  }
  function packMarkup(pack) {
    return `<button class="pack-tier ${pack.id===selectedPackId?'selected':''}" style="--pack-accent:${pack.color}" data-select-pack="${pack.id}" aria-pressed="${pack.id===selectedPackId}"><span class="tier-swatch"><i></i></span><span class="tier-name"><b>${escapeHtml(packName(pack))}</b><small>${pack.count} ${language==='zh'?'张卡牌':pack.count===1?'CARD':'CARDS'}</small></span><span class="tier-price">${formatMoney(packPrice(pack))}<small>USDT</small></span></button>`;
  }
  function packStageMarkup(pack) {
    return `<div class="pack-stage-inner" style="--pack-accent:${pack.color}"><div class="pack-scene" aria-label="${escapeHtml(packName(pack))} ${language==='zh'?'卡包':'sealed pack'}"><div class="pack-halo"></div><div class="pack-object"><div class="pack-crimp pack-crimp-top"></div><div class="pack-crimp pack-crimp-bottom"></div><div class="pack-seal"><small>BAI TCG · BNB CHAIN</small><b>${language==='zh'?'创世':'GENESIS'}</b><span>${language==='zh'?'第 01 赛季':'SEASON 01'} · ${String(pack.count).padStart(2,'0')} ${language==='zh'?'张卡':'CARDS'}</span></div><div class="pack-foil-mark">✧</div></div><div class="pack-reflection"></div></div><div class="pack-stage-copy"><h2>${escapeHtml(packName(pack))}</h2></div></div>`;
  }
  function packOrderbarMarkup(pack) {
    const total = Math.round(packPrice(pack) * packQuantity * 100) / 100;
    const maxQuantity = Math.min(10,availablePacks(pack));
    if (packQuantity > maxQuantity && maxQuantity > 0) packQuantity = maxQuantity;
    const stockAvailable = maxQuantity > 0 && packQuantity <= maxQuantity;
    const affordable = state.usdt >= total;
    const note = !stockAvailable ? (language==='zh'?'已售罄':'Sold out') : !affordable ? (language==='zh'?'余额不足':'Insufficient balance') : '';
    return `<div class="pack-order-controls"><div class="pack-balance-box"><small>${language==='zh'?'演示余额':'DEMO BALANCE'}</small><b>${formatMoney(state.usdt)} <i>USDT</i></b></div><div class="pack-quantity-box"><span>${language==='zh'?'数量':'QUANTITY'}</span><div class="quantity-stepper"><button data-pack-step="-1" aria-label="${language==='zh'?'减少卡包数量':'Decrease pack quantity'}" ${packQuantity<=1?'disabled':''}>−</button><b id="pack-quantity">${packQuantity}</b><button data-pack-step="1" aria-label="${language==='zh'?'增加卡包数量':'Increase pack quantity'}" ${packQuantity>=maxQuantity?'disabled':''}>＋</button></div></div></div><button class="pack-open-button" data-mint-selected-pack ${affordable&&stockAvailable?'':'disabled'}><span class="pack-open-icon">◆</span><span>${language==='zh'?'开包':'Get pack'}</span><b>${formatMoney(total)} <small>USDT</small></b></button>${note?`<p class="pack-order-note">${note}</p>`:''}`;
  }
  function renderOdds() {
    const pack = PACKS.find(item=>item.id===selectedPackId) || PACKS[0];
    const odds = currentOdds(pack);
    const poolCount = state.batchPools?.[pack.id]?.length || 0;
    const worstChance = probabilityAllOf(pack, 'N');
    const topChance = probabilityAtLeastOne(pack, ['UR']);
    el('rarity-odds').innerHTML = `<div class="rarity-odds-heading"><b>${escapeHtml(packName(pack))}</b><span>${language==='zh'?'批次':'BATCH'} ${BATCH_ID} · ${language==='zh'?'剩余':'LEFT'} ${poolCount} · ${pack.count} ${language==='zh'?'张/包':'cards/pack'}</span></div><div class="rarity-odds-summary"><span>${language==='zh'?'全普通':'All common'} <b>${formatOdds(worstChance)}</b></span><span>${language==='zh'?'至少一张SSS':'At least one SSS'} <b>${formatOdds(topChance)}</b></span></div>${odds.map(item => { const packChance=probabilityAtLeastOne(pack,[item.id]); return `<div style="--rarity:${item.color}"><i class="rarity-dot"></i><span><b>${item.grade} · ${escapeHtml(language==='zh'?item.labelZh:item.label)}</b><small>${language==='zh'?'单张':'Card'} ${formatOdds(item.odds)} · ${language==='zh'?'整包≥1':'Pack ≥1'} ${formatOdds(packChance)}</small></span></div>`; }).join('')}`;
  }
  function renderCollection() {
    const counts = inventoryCounts();
    const ownedCodes = [...counts.keys()];
    const total = CARDS.length;
    const pct = Math.round(ownedCodes.length / total * 100);
    el('completion-count').textContent = `${ownedCodes.length} / ${total}`;
    el('completion-percent').textContent = `${pct}%`;
    el('completion-ring').style.setProperty('--progress', `${pct}%`);
    let cards = CARDS.filter(card => catalogRarity === 'all' || card.rarity === catalogRarity);
    if (catalogQuery) cards = cards.filter(card => `${card.name} ${card.en} ${card.code} ${elementTitle(card.element)} ${factionTitle(card.faction)} ${cardTitle(card)} ${(CARD_COPY[card.code] || []).join(' ')} ${CARD_CRYPTO_MOTIF[card.code] || ''}`.toLowerCase().includes(catalogQuery.toLowerCase()));
    el('catalog-grid').innerHTML = cards.length ? cards.map(card => cardMarkup(card,{count:counts.get(card.code)})).join('') : '<div class="empty-state">No cards match this search.</div>';
    const featured = ['GC-074','GC-075','GC-071','GC-072','GC-068','GC-065'].map(code => cardByCode.get(code));
    el('featured-cards').innerHTML = featured.map(card => cardMarkup(card,{count:counts.get(card.code)})).join('');
  }
  function renderShop() {
    const selected = PACKS.find(pack => pack.id === selectedPackId) || PACKS[0];
    el('pack-grid').innerHTML = PACKS.map(packMarkup).join('');
    el('pack-stage').style.setProperty('--pack-accent',selected.color);
    el('pack-stage').innerHTML = packStageMarkup(selected);
    el('pack-orderbar').innerHTML = packOrderbarMarkup(selected);
    renderOdds();
  }
  function renderFusion() {
    const selectable = state.inventory.filter(item => NEXT_RARITY[cardByCode.get(item.code)?.rarity]);
    const selectedValid = [...selectedFusion].map(id => selectable.find(card => card.id === id)).filter(Boolean);
    selectedFusion = new Set(selectedValid.map(card => card.id));
    el('fusion-selected-count').textContent = `Selected ${selectedValid.length} / 3`;
    const compatible = selectedValid.length === 3 && selectedValid.every(item => item.code === selectedValid[0].code);
    el('fuse-button').disabled = !compatible;
    el('fuse-button').textContent = compatible ? 'Forge' : 'Forge';
    el('fusion-inventory').innerHTML = selectable.length ? selectable.map(item => `<button class="select-card ${selectedFusion.has(item.id)?'selected':''}" data-fusion-card="${item.id}">${cardMarkup(item)}</button>`).join('') : '<div class="empty-state">No cards</div>';
  }
  function marketRarityOf(item) { return cardByCode.get(item.code)?.rarity || 'N'; }
  function renderMarket() {
    let listings = state.market.filter(item => marketRarity === 'all' || marketRarityOf(item) === marketRarity);
    if (marketSort === 'low') listings = listings.sort((a,b) => a.price-b.price);
    if (marketSort === 'high') listings = listings.sort((a,b) => b.price-a.price);
    el('market-grid').innerHTML = listings.length ? listings.map(item => {
      const card = cardByCode.get(item.code);
      const ownListing = item.seller === 'You · Local demo listing';
      const action = ownListing
        ? `<button data-market-cancel="${escapeHtml(item.id)}">${language==='zh'?'撤下挂单':'Cancel listing'}</button>`
        : `<button data-market-buy="${escapeHtml(item.id)}">${language==='zh'?'购买':'Buy'}</button>`;
      return `<article class="market-item">${cardMarkup(card)}<div class="market-item-info"><div><span>${escapeHtml(item.seller)}</span><small>${escapeHtml(language==='zh'&&item.listed==='Just now'?'刚刚':item.listed || 'Just now')}</small></div><div class="market-item-tag">${escapeHtml(rarityGrade(card.rarity))} · ${escapeHtml(elementTitle(card.element))}</div><div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><b>${formatMoney(item.price)} <small>USDT</small></b></div>${action}</div></article>`;
    }).join('') : '<div class="empty-state">No listings</div>';
    el('market-volume').innerHTML = `${formatMoney(state.marketVolume)} <i>USDT</i>`;
  }
  function deckPower() {
    return state.deck.reduce((sum,id) => {
      const owned = state.inventory.find(item => item.id === id);
      const card = owned && cardByCode.get(owned.code);
      return sum + (card ? card.atk + Math.round(card.def*.55) : 0);
    },0);
  }
  function renderArena() {
    state.deck = state.deck.filter(id => state.inventory.some(item => item.id === id)).slice(0,3);
    const power = deckPower();
    el('deck-power').textContent = String(power).padStart(3,'0');
    el('deck-count').textContent = `${state.deck.length} / 3`;
    el('deck-slots').innerHTML = [0,1,2].map(index => {
      const item = state.inventory.find(card => card.id === state.deck[index]);
      return item ? `<div class="deck-slot">${cardMarkup(item)}<button data-remove-deck="${item.id}">Remove ×</button></div>` : `<div class="deck-slot">Select card</div>`;
    }).join('');
    const used = new Set(state.deck);
    const selectable = state.inventory.slice(-60).reverse();
    el('deck-picker').innerHTML = selectable.length ? selectable.map(item => `<button class="deck-pick ${used.has(item.id)||state.deck.length>=3?'disabled':''}" data-deck-card="${item.id}" title="Add to squad">${cardMarkup(item)}<span>${escapeHtml(cardTitle(cardByCode.get(item.code)))}</span></button>`).join('') : '<div class="empty-state">No cards</div>';
  }
  function renderProfile() {
    const counts = inventoryCounts();
    const unique = counts.size;
    const metrics = language==='zh' ? [['卡牌',state.inventory.length],['不同卡牌',`${unique} / ${CARDS.length}`],['演示余额',`${formatMoney(state.usdt)} USDT`]] : [['Cards',state.inventory.length],['Unique',`${unique} / ${CARDS.length}`],['Demo balance',`${formatMoney(state.usdt)} USDT`]];
    el('profile-metrics').innerHTML = metrics.map(([label,value]) => `<div class="profile-metric"><small>${label}</small><b>${value}</b></div>`).join('');
    el('opened-pack-count').textContent = String(state.packHistory.length);
    el('sealed-pack-count').textContent = String(state.sealedPacks.length);
    el('sealed-pack-list').innerHTML = state.sealedPacks.length ? state.sealedPacks.slice().reverse().map(box => { const pack=PACKS.find(item=>item.id===box.packId); if(!pack)return ''; return `<div class="sealed-pack-row"><span><b>${escapeHtml(packName(pack))}</b><small>#${escapeHtml(box.id.slice(-6))} · ${pack.count} ${language==='zh'?'张卡牌':pack.count===1?'card':'cards'}</small></span><button class="button button-quiet" data-open-sealed-pack="${escapeHtml(box.id)}" ${activePack?.id===box.id?'disabled':''}>${language==='zh'?'开启':'Open'}</button></div>`; }).join('') : `<div class="empty-state">${language==='zh'?'暂无卡包':'No packs'}</div>`;
    el('pack-history').innerHTML = state.packHistory.length ? state.packHistory.slice(0,10).map(item => `<div class="history-row"><span>${escapeHtml(item.name)} ×${item.packs || 1} · ${item.count} cards · ${item.at}</span><b>-${formatMoney(item.price)} USDT</b></div>`).join('') : '<div class="empty-state">No openings</div>';
    el('activity-history').innerHTML = state.activity.length ? state.activity.slice(0,12).map(item => `<div class="history-row"><span>${escapeHtml(item.text)}</span><b>${escapeHtml(item.at)}</b></div>`).join('') : '<div class="empty-state">No activity</div>';
  }
  function render() {
    el('top-card-count').textContent = state.inventory.length;
    renderShop(); renderCollection(); renderFusion(); renderMarket(); renderArena(); renderProfile();
  }
  function addDemoResources() {
    const supplies = ['GC-001','GC-001','GC-001','GC-003','GC-003','GC-004','GC-007','GC-007','GC-009','GC-012','GC-015','GC-015','GC-018'];
    supplies.forEach(code => state.inventory.push(createOwnedCard(code)));
    state.usdt += 50;
    addActivity('Loaded 13 demo cards and 50 Demo USDT', 'Demo collection');
    save(); render(); toast('Demo loaded.');
  }
  function mintSealedPacks(packId, quantity = packQuantity) {
    const pack = PACKS.find(item => item.id === packId);
    if (!pack) return;
    quantity = Math.max(1, Math.min(10, Math.floor(Number(quantity) || 1)));
    if (availablePacks(pack) < quantity) { toast('Batch sold out.'); return; }
    const unitPriceCents = toCents(packPrice(pack));
    const totalPriceCents = unitPriceCents === null ? null : unitPriceCents * quantity;
    const balanceCents = toCents(state.usdt);
    if (!Number.isSafeInteger(totalPriceCents) || !Number.isSafeInteger(balanceCents) || balanceCents < totalPriceCents) { toast('Insufficient balance.'); return; }
    const reservations = [];
    for (let index=0; index<quantity; index++) {
      const assets = reserveBatchAssets(pack,pack.count);
      if (!assets) { toast('Batch sold out.'); return; }
      reservations.push(assets);
    }
    state.usdt = (balanceCents - totalPriceCents) / 100;
    const unitPrice = unitPriceCents / 100;
    for (let index=0; index<quantity; index++) state.sealedPacks.push({id:`box-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,packId:pack.id,price:unitPrice,reservedAssets:reservations[index],mintedAt:new Date().toISOString(),assetState:'Local demo pack'});
    addActivity(`${quantity} ${pack.en} demo ${quantity===1?'pack':'packs'} created`, 'Sealed pack'); save(); render();
    toast(`${quantity} pack${quantity===1?'':'s'} added.`);
  }
  function openSealedPack(boxId) {
    const box = state.sealedPacks.find(item => item.id === boxId);
    const pack = PACKS.find(item => item.id === box?.packId);
    if (!box || !pack || activePack) return;
    if (!Array.isArray(box.reservedAssets)) {
      box.reservedAssets = reserveBatchAssets(pack,pack.count);
      if (!box.reservedAssets) { toast('Batch sold out.'); return; }
    }
    activePack = {...box, pack};
    el('pack-results').hidden = true; el('pack-animation').hidden = false;
    el('pack-animation').classList.remove('is-opening');
    el('pack-dialog').style.setProperty('--pack-accent',pack.color);
    el('pack-animation-tier').textContent = language==='zh'?`${pack.nameZh} · 已封装`:`${pack.en} · SEALED`;
    el('pack-animation-label').textContent = language==='zh'?'开包中…':'Opening…';
    el('result-cards').scrollTop = 0;
    el('pack-dialog').scrollTop = 0;
    el('pack-dialog').showModal();
    requestAnimationFrame(() => el('pack-animation').classList.add('is-opening'));
    packRevealTimer = window.setTimeout(() => {
      packRevealTimer = null;
      if (!el('pack-dialog').open) return;
      const cards = box.reservedAssets.map(asset=>createOwnedCard(asset.code,asset.assetId));
      state.inventory.push(...cards);
      state.sealedPacks = state.sealedPacks.filter(item => item.id !== box.id);
      const history = {name:pack.en,packs:1,count:cards.length,price:box.price,at:new Date().toLocaleString('en-US',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'})};
      state.packHistory.unshift(history);
      addActivity(`Opened ${pack.en} · ${cards.length} cards`, 'Pack opened');
      activePack = null; save(); render();
      el('pack-animation').hidden = true;
      el('result-title').textContent = language==='zh'?`${cards.length} 张卡牌`:`${cards.length} cards`;
      el('result-cards').innerHTML = cards.map((card,index) => `<div class="result-card-item" style="--reveal-order:${Math.min(index,12)}">${cardMarkup(card)}</div>`).join('');
      el('result-cards').scrollTop = 0;
      el('pack-results').hidden = false;
    }, 2100);
  }
  function fuseCards() {
    const chosen = [...selectedFusion].map(id => state.inventory.find(card => card.id === id)).filter(Boolean);
    if (chosen.length !== 3 || chosen.some(item => item.code !== chosen[0].code)) { toast('Select 3 identical cards.'); return; }
    const source = cardByCode.get(chosen[0].code), targetRarity = NEXT_RARITY[source.rarity];
    if (!targetRarity) { toast('SSS is the top tier.'); return; }
    chosen.forEach(item => state.inventory.splice(state.inventory.findIndex(card => card.id === item.id),1));
    const candidates = CARDS.filter(card => card.rarity === targetRarity);
    const target = candidates[randomInt(candidates.length)];
    const result = createOwnedCard(target.code);
    state.inventory.push(result); selectedFusion.clear(); addActivity(`Forged ${cardTitle(source)} ×3 → ${cardTitle(target)}`, 'Card forge'); save(); render();
    el('fusion-stage').innerHTML = `<div class="forge-rune">✧</div><h2>Forged</h2>${cardMarkup(result)}`;
  }
  function buyListing(listingId) {
    const index = state.market.findIndex(item => item.id === listingId);
    if (index < 0) return;
    const listing = state.market[index];
    const ownListing = listing.seller === 'You · Local demo listing';
    if (ownListing) return;
    const priceCents = toCents(listing.price);
    const balanceCents = toCents(state.usdt);
    if (priceCents === null || priceCents <= 0 || balanceCents === null || balanceCents < priceCents) { toast('Insufficient balance.'); return; }
    const feeCents = Math.floor(priceCents * 200 / 10_000);
    state.usdt = (balanceCents-priceCents)/100;
    state.marketplaceFeePool = ((toCents(state.marketplaceFeePool || 0) ?? 0)+feeCents)/100;
    const volumeCents = toCents(state.marketVolume);
    state.inventory.push(createOwnedCard(listing.code));
    state.marketVolume = ((volumeCents ?? 0) + priceCents) / 100;
    state.market.splice(index,1);
    addActivity(`Bought ${cardTitle(cardByCode.get(listing.code))} · ${formatMoney(listing.price)} USDT`, 'Demo market'); save(); render(); toast('Purchased.');
  }
  function cancelListing(listingId) {
    const index = state.market.findIndex(item => item.id === listingId);
    if (index < 0) return;
    const listing = state.market[index];
    if (listing.seller !== 'You · Local demo listing') return;
    const returnedCard = listing.cardSnapshot || createOwnedCard(listing.code);
    state.market.splice(index,1);
    state.inventory.push(returnedCard);
    addActivity(`Cancelled listing · ${cardTitle(cardByCode.get(returnedCard.code))}`, 'Demo market');
    save(); render(); toast(language==='zh'?'已撤下挂单':'Listing cancelled.');
  }
  function showSellDialog() {
    if (!state.inventory.length) { toast('No cards to sell.'); return; }
    el('sell-card-select').innerHTML = state.inventory.map(item => `<option value="${item.id}">${escapeHtml(cardTitle(cardByCode.get(item.code)))} · ${escapeHtml(rarityGrade(cardByCode.get(item.code).rarity))} · ${item.id.slice(-5)}</option>`).join('');
    el('sell-dialog').showModal();
  }
  function createListing() {
    const id = el('sell-card-select').value, rawPrice = Number(el('sell-price').value);
    const index = state.inventory.findIndex(item => item.id === id);
    if (index < 0 || !Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice > 1_000_000) { toast('Check card and price.'); return; }
    const price = Math.round(rawPrice*100)/100;
    const [card] = state.inventory.splice(index,1);
    state.market.unshift({id:`local-${Date.now()}-${randomInt(1_000_000)}`,code:card.code,cardSnapshot:card,price,seller:'You · Local demo listing',listed:'Just now'});
    addActivity(`Listed ${cardTitle(cardByCode.get(card.code))} · ${formatMoney(price)} USDT`, 'Demo listing'); save(); el('sell-dialog').close(); render(); toast('Listed.');
  }
  function battle() {
    if (state.deck.length < 3) { toast('Select 3 cards.'); return; }
    const cards = state.deck.map(id => cardByCode.get(state.inventory.find(item=>item.id===id).code));
    const power = deckPower();
    const elements = new Set(cards.map(card => card.element)).size;
    const factionBonus = new Set(cards.map(card => card.faction)).size === 3 ? 8 : 0;
    const score = power + elements*8 + factionBonus;
    const victory = score >= 245;
    const result = el('battle-result');
    result.className = `battle-result ${victory?'success':'fail'}`;
    result.textContent = `${victory?'CLEARED':'DEFEATED'} · Power ${score} · Elements ${elements}/3${factionBonus?' · Faction +8':''}`;
    addActivity(`${victory?'Cleared':'Completed'} Void Echo · ${score} power`, 'PVE simulation'); save(); renderProfile();
  }
  function resetDemo() {
    if (!window.confirm('Reset demo?')) return;
    state = freshState(); selectedFusion.clear(); save(); render(); toast('Reset.');
  }

  document.addEventListener('click', event => {
    if (event.target.closest('#lang-zh')) { setLanguage('zh'); return; }
    if (event.target.closest('#lang-en')) { setLanguage('en'); return; }
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) { event.preventDefault(); switchView(viewButton.dataset.view); }
    const tierButton = event.target.closest('[data-select-pack]');
    if (tierButton) { selectedPackId = tierButton.dataset.selectPack; packQuantity = 1; renderShop(); }
    const packStep = event.target.closest('[data-pack-step]');
    if (packStep) { packQuantity = Math.max(1,Math.min(10,packQuantity + Number(packStep.dataset.packStep))); renderShop(); }
    if (event.target.closest('[data-mint-selected-pack]')) mintSealedPacks(selectedPackId,packQuantity);
    const sealedPackButton = event.target.closest('[data-open-sealed-pack]');
    if (sealedPackButton) openSealedPack(sealedPackButton.dataset.openSealedPack);
    const closeButton = event.target.closest('[data-close-dialog]');
    if (closeButton) { const dialog = closeButton.closest('dialog'); if (dialog?.open) { if (dialog.id === 'pack-dialog') { if (packRevealTimer) { clearTimeout(packRevealTimer); packRevealTimer = null; } activePack=null; renderProfile(); } dialog.close(); } }
    const fusionButton = event.target.closest('[data-fusion-card]');
    if (fusionButton) {
      if (selectedFusion.has(fusionButton.dataset.fusionCard)) selectedFusion.delete(fusionButton.dataset.fusionCard);
      else if (selectedFusion.size < 3) selectedFusion.add(fusionButton.dataset.fusionCard);
      else toast('Choose up to three forge materials.');
      renderFusion();
    }
    const marketBuy = event.target.closest('[data-market-buy]');
    if (marketBuy) buyListing(marketBuy.dataset.marketBuy);
    const marketCancel = event.target.closest('[data-market-cancel]');
    if (marketCancel) cancelListing(marketCancel.dataset.marketCancel);
    const deckPick = event.target.closest('[data-deck-card]');
    if (deckPick && state.deck.length < 3 && !state.deck.includes(deckPick.dataset.deckCard)) { state.deck.push(deckPick.dataset.deckCard); save(); renderArena(); }
    const deckRemove = event.target.closest('[data-remove-deck]');
    if (deckRemove) { state.deck = state.deck.filter(id => id !== deckRemove.dataset.removeDeck); save(); renderArena(); }
    const filter = event.target.closest('#catalog-filters [data-rarity]');
    if (filter) { catalogRarity=filter.dataset.rarity; document.querySelectorAll('#catalog-filters button').forEach(button=>button.classList.toggle('selected',button===filter)); renderCollection(); }
    const mfilter = event.target.closest('#market-rarity [data-rarity]');
    if (mfilter) { marketRarity=mfilter.dataset.rarity; document.querySelectorAll('#market-rarity button').forEach(button=>button.classList.toggle('selected',button===mfilter)); renderMarket(); }
    if (event.target.closest('#grant-demo, #footer-grant')) addDemoResources();
    if (event.target.closest('#fuse-button')) fuseCards();
    if (event.target.closest('#sell-card-button')) showSellDialog();
    if (event.target.closest('#confirm-listing')) createListing();
    if (event.target.closest('#battle-button')) battle();
    if (event.target.closest('#reset-demo')) resetDemo();
  });
  el('pack-dialog').addEventListener('close', () => {
    if (packRevealTimer) { clearTimeout(packRevealTimer); packRevealTimer = null; }
    activePack = null;
    renderProfile();
  });
  el('catalog-search').addEventListener('input', event => { catalogQuery=event.target.value.trim(); renderCollection(); });
  el('market-sort').addEventListener('change', event => { marketSort=event.target.value; renderMarket(); });
  el('mobile-menu').addEventListener('click', () => document.querySelector('.main-nav').classList.toggle('open'));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('.main-nav').classList.remove('open'); });

  render();
  document.documentElement.lang=language==='en'?'en':'zh-CN';
  document.title=language==='en'?'BAI TCG · Crypto Genesis':'BAI TCG · 加密创世纪';
  el('lang-zh').classList.toggle('active',language==='zh'); el('lang-en').classList.toggle('active',language==='en');
  el('lang-zh').setAttribute('aria-pressed',String(language==='zh')); el('lang-en').setAttribute('aria-pressed',String(language==='en'));
  localizeTree();
  const languageObserver=new MutationObserver(records=>records.forEach(record=>{
    if(record.type==='characterData') localizeNode(record.target);
    record.addedNodes?.forEach(node=>{ if(node.nodeType===Node.TEXT_NODE) localizeNode(node); else if(node.nodeType===Node.ELEMENT_NODE) localizeTree(node); });
  }));
  languageObserver.observe(document.body,{subtree:true,childList:true,characterData:true});
})();
