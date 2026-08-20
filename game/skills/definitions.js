const { SKILL_TAGS, CARD_EDIT_TAGS, PROTOCOL_CATEGORIES, SKILL_CONFIG } = require("../skillConfig");

const ACTIVE_STREETS = Object.freeze(["pre_flop", "flop", "turn", "river"]);
const POST_FLOP_STREETS = Object.freeze(["flop", "turn", "river"]);

function freezeSkill(skill) {
  const shortDescription = skill.shortDescription || skill.description || "";
  const expertDescription = skill.expertDescription || shortDescription;
  return Object.freeze({
    maxUsesPerHand: null,
    maxUsesPerGame: null,
    requiresActionTurn: false,
    requiresFirstSkillEvent: false,
    canBeCountered: Boolean(skill.tags?.includes(SKILL_TAGS.ACTIVE)),
    visibility: "PUBLIC",
    allowedPhases: Object.freeze([]),
    protocolCategory: null,
    energyCosts: null,
    ...skill,
    shortDescription,
    expertDescription,
    description: shortDescription,
    tags: Object.freeze(skill.tags || []),
    allowedPhases: Object.freeze(skill.allowedPhases || []),
    energyCosts: skill.energyCosts ? Object.freeze(skill.energyCosts) : null,
  });
}

function protocolSkill(id, name, category, shortDescription, expertExtra) {
  return freezeSkill({
    id,
    name,
    load: 1,
    energyCost: 0,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.PROTOCOL, SKILL_TAGS.SETTLEMENT, SKILL_TAGS.SECRET],
    visibility: "SECRET",
    protocolCategory: category,
    shortDescription,
    expertDescription:
      `${shortDescription} 必须进入 Showdown，且最终最佳五张牌恰好为指定牌型并赢得本手。Fold 获胜不触发。` +
      ` 若本手已有由你自己技能产生的其他筹码倍率（血战/绝境/绝路等），本协议不触发。` +
      ` 对手技能产生的倍率不会阻止本协议，可继续乘法叠加。奖励为标准净收益 ×${SKILL_CONFIG.PROTOCOL_WIN_MULTIPLIER}。` +
      (expertExtra ? ` ${expertExtra}` : ""),
  });
}

const SKILL_DEFINITIONS = Object.freeze({
  DEEP_BREATH: freezeSkill({
    id: "DEEP_BREATH", name: "深呼吸", load: 1, energyCost: 1,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.RESOURCE, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, canBeCountered: true,
    shortDescription: "花 1 点能量缓一口气。如果这手牌你不再用别的技能，结束时会拿回 2 点，相当于净赚 1 点。",
    expertDescription: "主动技能。负载 1，费用 1，每手最多 1 次，仅能在自己的合法下注行动回合发动，翻牌前至河牌均可。发动时支付 1 能量；若此后直到本手结束没有再发生任何自己的技能事件，手牌结束时恢复 2 能量。无当前能量上限要求，只受实际能量上限约束。Fold 后仍正常结算。若深呼吸后无其他技能事件且自己 Fold：恢复 2，并再获得败局自然 +1。公平会抑制本手全部结束恢复。",
  }),
  RECYCLE: freezeSkill({
    id: "RECYCLE", name: "回收利用", load: 2, energyCost: 0,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.RESOURCE],
    shortDescription: "这手牌里如果有技能已经扣了能量却没成功，结束时会把其中最贵的那一次按半价退回来。",
    expertDescription: "被动技能。负载 2，费用 0，每手最多结算一次。手牌结束时统计本手所有“已通过合法性检查 + 已真实支付能量 + 最终结算失败”的技能，取原始能量费用最高的一次，返还 floor(原始费用 × 50%)。符合：被反制、被绝密阻止、隐藏目标实际不存在、目标已离开合法区域。不符合：扣费前非法拒绝、玩家取消、网络重发、客户端重复请求、反制成功放置但整手无人触发。不在中途立即返还。",
  }),
  INTIMIDATION: freezeSkill({
    id: "INTIMIDATION", name: "恐吓", load: 3, energyCost: 4,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, canBeCountered: true,
    shortDescription: "这手牌谁都不能弃牌，而且双方这手最多只能再往锅里丢到总共 500。",
    expertDescription: "主动/公开。负载 3，费用 4，每手最多 1 次，任意自己的合法下注行动回合可发动。前提：双方当前累计标准下注投入均不得超过 500。成功后直到本手结束：双方禁止 Fold；每人累计标准下注投入最多 500；Bet/Raise 必须限制在对手仍可合法 Call 的范围内。恐吓下仍允许点击 ALL IN，但实际标准投入最多增加到累计 500，同时记录为合法 ALL IN 行为（allInAction=true，若筹码未全部投入则 stackCommitted=false），以触发依赖 ALL IN 动作的技能。500 上限只限制标准下注投入，不限制技能倍率造成的最终额外筹码转移。",
  }),
  DESPERATION: freezeSkill({
    id: "DESPERATION", name: "绝境", load: 2, energyCost: 0,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.SETTLEMENT],
    shortDescription: "一手牌开始时如果你只剩 200 或更少筹码，这手赢了会把净赢筹码变成三倍，并额外回 1 点能量。",
    expertDescription: "被动技能。负载 2，费用 0。每手开始时检查手牌开始筹码快照：若自身筹码 <= 200，本手自动进入绝境。不要根据当前筹码、是否 ALL IN、是否落后动态触发。若最终获胜：标准净筹码收益 ×3，并额外恢复 1 能量。平局不触发倍率。",
  }),
  BLOOD_BATTLE: freezeSkill({
    id: "BLOOD_BATTLE", name: "血战", load: 2, energyCost: 3,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.SETTLEMENT, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, canBeCountered: true,
    shortDescription: "这手牌最终输赢筹码翻倍。两边都开血战就是四倍，不会互相抵消。",
    expertDescription: "主动/公开。负载 2，费用 3，每手最多 1 次，任意合法下注阶段可发动。本手最终标准净筹码转移 ×2。双方都发动时 ×2 ×2 = ×4，不是互相抵消。允许与绝境、绝路、协议以外的合法倍率按乘法叠加。平局不进行胜负倍率放大。最终支付仍不得超过败方实际可支付筹码。",
  }),
  DEFENSE: freezeSkill({
    id: "DEFENSE", name: "防守", load: 3, energyCost: 3,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.DEFENSE, SKILL_TAGS.SETTLEMENT, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET", canBeCountered: true,
    shortDescription: "偷偷垫一层。如果你没弃牌却输掉这手，最终亏的筹码会减半。",
    expertDescription: "主动/秘密。负载 3，费用 3，每手最多 1 次，翻牌前至河牌任意自己的合法下注行动回合可发动。若自己最终输掉本手并且不是主动 Fold，最终净筹码损失减半；覆盖整手最终损失，与发动阶段无关。赢、平局或主动 Fold 则无收益，已支付 3 能量不返还。发动本身秘密；若结算时确实把一个公开损失减半，此时可以自然确认「防守」。",
  }),
  PERCEPTION: freezeSkill({
    id: "PERCEPTION", name: "感知", load: 3, energyCost: 0,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.INFORMATION, SKILL_TAGS.SECRET],
    visibility: "SECRET",
    shortDescription: "发牌过程中有时会突然对你耳语一句对手底牌的感觉，真假参半，对手看不见。",
    expertDescription: "被动/完全秘密/情报。负载 3，费用 0。判定节点：底牌发完、Flop、Turn、River，四次独立判定，每手最多成功触发 3 次。触发概率随自身筹码劣势在 25%～50% 之间（FROZEN_V1：spec-25-50）。每次成功先按固定权重选择信息类别，再 75% 真、25% 假，然后在该类别内生成满足真假要求的命题。假信息必须选自当前真实状态下确实为假的命题，不能输出逻辑不可能或观察者已能直接证伪的信息。同手避免完全相同、等价或直接逻辑否定的命题。触发事件、内容与真假全部对对手隐藏。灵视只能发现“本手发生过感知事件”，不能看到具体内容与真假。绝密可以阻止感知访问受保护的底牌信息。",
  }),
  INTEL_ONE: freezeSkill({
    id: "INTEL_ONE", name: "情报", load: 3, energyCost: 4,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.INFORMATION, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET", canBeCountered: true,
    shortDescription: "花 4 点能量看一眼：要么随机翻开对手一张底牌，要么偷看一张还没发出的公共牌位置。",
    expertDescription: "主动/秘密。负载 3，费用 4，每手最多 1 次。发动前必须选择模式。模式 A：系统随机精确查看对手一张底牌，100% 真实，不是玩家选择左右。模式 B：选择任意一个尚未发出的公共牌位置（包括翻牌前直接看未来 River），得到该位置当前真实预定牌，100% 真实。模式和目标必须在扣费前确定。底牌模式被绝密阻止则技能失败，不能再临时改看公共牌。未来公共牌分支不受绝密影响。",
  }),
  TOP_SECRET: freezeSkill({
    id: "TOP_SECRET", name: "绝密", load: 3, energyCost: 3,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.DEFENSE, SKILL_TAGS.SECRET],
    visibility: "SECRET",
    shortDescription: "有人第一次动你底牌时，若你还有至少 3 点能量，会自动挡住，并让这手剩下的时间都护住你的底牌。",
    expertDescription: "被动/秘密/信息防御。负载 3，费用 3，每手最多自动启动一次。当敌方技能第一次试图读取、推断、交换、零化或直接操作本人私人底牌信息时，若当前能量 >= 3，自动支付 3 能量，阻止该次敌方技能，然后本手剩余时间持续保护本人底牌私人信息，之后不再重复扣 3。能量不足则不发动，不允许透支。阻挡：感知相关底牌信息、情报底牌模式、千术对手底牌模式、零化底牌模式及未来同类技能。不阻挡：公共牌情报、灵视、纯技能元信息。第一次真正产生阻挡时，对方确认「绝密」存在。",
  }),
  COUNTER: freezeSkill({
    id: "COUNTER", name: "反制", load: 4, energyCost: 4,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ["pre_flop"], maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET", canBeCountered: true,
    shortDescription: "翻牌前偷偷下一张陷阱。对手下一次真正使出的主动技能会白花钱并且失败，这手也不能再动技能。",
    expertDescription: "主动/秘密/控制。负载 4，费用 4，只能翻牌前在自己的合法行动回合秘密放置，每手最多 1 次。之后捕获对手下一次合法主动技能：先通过合法性判断，正常支付能量，反制触发，该技能失败；然后对手本手剩余时间不能再发动主动技能，也不能再产生新的被动技能事件。已经完成的效果不追溯取消。被动技能本身不会作为“下一次主动技能”触发反制。反制可以反制对方正在放置的反制。非法技能请求不能消耗反制。公平不能被反制。若整手没有触发，手牌结束返还 1 能量（空放净成本 3）。核心语义是触发瞬间阻止目标技能，不对天命等技能削弱反制。",
  }),
  FAIRNESS: freezeSkill({
    id: "FAIRNESS", name: "公平", load: 4, energyCost: 3,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, canBeCountered: false,
    shortDescription: "当场清掉双方还没结算完的技能状态，这手谁都不能再动技能，结束时也不再回能量。已经换完的牌不会变回去。",
    expertDescription: "主动/公开/全局控制。负载 4，费用 3，每手最多 1 次，可在自己的任意合法下注行动回合使用，不必是本手第一个技能。不能被反制阻止。发动成功后立即清除双方当前存在的持续技能、预埋技能、待结算技能、尚未完成的技能状态（含血战、防守、恐吓、绝密保护、绝境待结算、反制陷阱、深呼吸待恢复、零化、贷款未偿债务、撤退、未触发试探、伪装）；本手剩余时间双方均不能发动主动技能或产生新的被动技能事件；本手所有手牌结束能量恢复全部取消，包括败者自然 +1、深呼吸恢复、绝境恢复、资源型强运恢复及其他技能手牌结束恢复。公平不是时间回溯：不能恢复已经交换完成的牌、已经改变完成的牌堆、已经看见的信息、已经发生的筹码变化、已经完成的终局直接筹码转移。零化属于持续结算状态，因此公平可以取消零化。公平成功后本手不能再发动终局。公平仍可清除贷款的 pending repayment 与 residual debt，但不回滚已取得的筹码或能量。若这次实际清掉任何金额大于 0 的贷款债务，则该玩家贷款信用按正式贷款规则结算：正常信用变为信用受限；已受限则保持受限；已违约则脱离完全封禁并进入信用受限，不能直接恢复正常信用。发动时没有任何贷款债务，不得改变贷款信用状态。",
  }),
  CHEAT: freezeSkill({
    id: "CHEAT", name: "千术", load: 5, energyCost: 6,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.HOLE_EDIT, SKILL_TAGS.DECK_EDIT, SKILL_TAGS.BOARD_EDIT, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "MIXED", canBeCountered: true,
    shortDescription: "把自己的一张底牌，和对手底牌位置、已亮的公共牌、还没发出的公共牌、下一张牌，或牌堆里一张不是下一家的暗牌交换。",
    expertDescription: "主动技能。负载 5，费用 6，每手最多 1 次，翻牌前至河牌（含 River 全部公开之后）可发动。选择本人一张底牌与以下目标之一交换：1) 对手指定底牌位置（不知牌值，受绝密保护）；2) 已经公开的任意公共牌（含 River 发完后），改动已公开公共牌会自然暴露千术；3) 任意尚未发出的未来公共牌位；4) 牌堆顶/下一张有效发牌；5) 从剩余未发牌堆均匀随机一张非顶部且排除下一张有效发牌的牌，旧底牌放回被抽牌原本准确位置。必须保持 52 张唯一。已经完成的交换属于既定事实，公平不能回滚。",
  }),
  DEAD_END: freezeSkill({
    id: "DEAD_END", name: "绝路", load: 4, energyCost: 5,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.SETTLEMENT, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, canBeCountered: true,
    shortDescription: "立刻按规则允许的最大 ALL IN，并让对手这手不能再动技能。如果对手弃牌，你这手净赢筹码变成三倍。",
    expertDescription: "主动/公开/ALL IN。负载 4，费用 5，每手最多 1 次，任意合法下注阶段可用。成功发动后自动执行当前规则允许的最大合法 ALL IN，然后对手本手不能再发动主动技能或产生新被动技能事件，但不取消已经完成或已经存在的既定事实。若对手之后 Fold：绝路玩家标准净收益 ×3。若对手 Call 并进入 Showdown，即使绝路玩家获胜，绝路本身不提供 ×3。恐吓状态下仍可发动；ALL IN 实际投入最多达到累计 500，但必须记录为 ALL IN 行为。由于恐吓禁止 Fold，绝路的 Fold ×3 分支在该情况下不会发生。",
  }),
  CLAIRVOYANCE: freezeSkill({
    id: "CLAIRVOYANCE", name: "灵视", load: 3, energyCost: 2,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.INFORMATION, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET", canBeCountered: true,
    shortDescription: "偷偷看一眼对手现在真正剩多少能量，以及这手已经实际发生过哪些技能，但看不到那些技能的具体内容。",
    expertDescription: "主动/秘密/元情报。负载 3，费用 2，每手最多 1 次。发动后私下读取：1) 对手当前真实能量值，不是冻结后的公开显示值；2) 本手截至当前对手已经完成的技能事件，包括原本秘密技能，但不能看到感知内容与真假、情报看到哪张牌、千术具体换了什么隐藏牌、天命指定哪张牌、强运改出了什么私人牌、贷款能量细节、重启抽到的牌，也不能看到尚未触发的完整构筑，也不能穿透伪装读取具体下注筹码。成功发动对手不知道。不受绝密阻挡。作为主动技能可以被反制。",
  }),
  NULLIFICATION: freezeSkill({
    id: "NULLIFICATION", name: "零化", load: 5, energyCost: 6,
    energyCosts: { board: 6, hole: 7 },
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.BOARD_EDIT, SKILL_TAGS.HOLE_EDIT, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: POST_FLOP_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET", canBeCountered: true,
    shortDescription: "让某张公共牌或对手一张随机底牌在这手算牌时当它不存在。两边可以点同一张公共牌，结算时才揭晓。",
    expertDescription: "主动/完全秘密。负载 5，每手最多 1 次，可在 Flop/Turn/River 使用。模式 A 公共牌零化费用 6：精确指定一个已经公开或尚未发出的公共牌位置，该牌在本手最终牌型计算中对双方都视为不存在；River 五张全部公开之后仍可使用。模式 B 底牌零化费用 7：系统从对手两张底牌中随机选择一张，使其不参与对手最佳五张牌计算，可被绝密阻止。发动、模式与目标均秘密，最终结算时才揭露。双方可以零化同一个公共牌位置：两次技能都正常成功并扣费，该公共牌最终只失效一次，过程中不泄露对方目标。零化是持续状态，因此公平可以清除零化。",
  }),
  FORTUNE: freezeSkill({
    id: "FORTUNE", name: "强运", load: 5, energyCost: 3,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.HOLE_EDIT, SKILL_TAGS.BOARD_EDIT, SKILL_TAGS.SECRET],
    visibility: "SECRET",
    shortDescription: "运气会自己站到你这边：有时悄悄换好你的底牌或即将发出的公共牌，有时结束时多回 1 点能量。改牌要花 3 点，能量可以暂时变成负数。",
    expertDescription: "被动/完全秘密/幸运系统。负载 5。牌型改写类强运成本 3 能量。在多个预定义幸运节点自动判定；概率同时受自身筹码劣势与当前能量影响。当前推荐 soft-v1，状态 FROZEN_V1（2026-08-20）。底牌已经足够优秀时不发动改善底牌类强运；较差时可自动改善，玩家不能选择是否触发、换哪张、换成什么。本人看到原牌→强运发生→新牌，对手不知道。只有真正触发改牌才扣费。公共牌强运只能根据本人底牌、当前公共牌与自身状态判断对自己更有利，不得读取对手底牌。资源强运在手牌结束判定成功时额外恢复 1 能量，本身不消耗能量，且不能递归触发另一次强运。强运允许能量降至 -4；若付费结果会低于 -4 则该付费强运不能发生。负能量时除强运外任何其他技能都不能主动发动或自动触发新的被动技能事件；已经完成的旧效果不回滚。",
  }),
  DESTINY: freezeSkill({
    id: "DESTINY", name: "天命", load: 5, energyCost: 7,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.DECK_EDIT, SKILL_TAGS.SECRET],
    allowedPhases: ["turn"], maxUsesPerHand: null, maxUsesPerGame: null, requiresActionTurn: true, visibility: "SECRET", canBeCountered: true,
    shortDescription: "转牌亮出后，花 7 点点名一张还在牌堆里的牌，立刻把它变成下一张真正会发出的河牌。带上这个技能，你的能量上限会变成 10。",
    expertDescription: "主动/完全秘密/牌堆控制。负载 5，费用 7。仅允许在 Turn 已经公开后的下注阶段、自己的合法行动回合发动。玩家选择一张具体真实扑克牌；若它当前仍在合法可操作牌堆中，立即把它移动到未来 River 的有效发牌位置（若存在烧牌，必须对应下一张真正作为 River 发出的有效牌位）。这是立即完成的真实牌堆修改，不是持续效果，因此公平不能回滚；之后新的牌堆操作仍可再次改变牌堆。若目标牌已在对手底牌、烧牌、已离开牌堆或其他非法不可操作区域，7 能量照常支付且天命失败。反制可以 100% 正常阻止天命。对手仍可以正常 Fold，即使天命已成功指定 River，7 能量不返还。携带天命时本人能量上限 8→10，初始能量仍为 4；这是构筑属性，公平不能把上限 10 变回 8。对手普通界面不直接显示 10 点上限。",
  }),
  LOAN: freezeSkill({
    id: "LOAN", name: "贷款", load: 2, energyCost: 2,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.RESOURCE],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 3, requiresActionTurn: true, visibility: "MIXED", canBeCountered: true,
    shortDescription: "可以借筹码或借能量。筹码立刻拿 100、下一手还 150；能量立刻 +5、下一手还 6。债务若被免除而不是用真实资源还清，贷款会进入信用受限。",
    expertDescription: "主动/资源。负载 2，费用 2。分支必须在扣费前锁定。筹码贷款与能量贷款可以同时存在。正常信用同一手：筹码贷款最多 2 次，能量贷款最多 1 次，合计最多 3 次。贷款有三种信用状态。NORMAL_CREDIT：使用上述正常额度。RESTRICTED_CREDIT：同一手所有贷款模式合计最多只能发动 1 次，不能再 Energy+Chip 或 Chip+Chip。DEFAULTED：存在尚未真实清偿的 residual debt 时，整个贷款技能完全不可发动。任意偿还失败形成的筹码债务或能量债务未清偿时，进入违约并封禁全部贷款，不再区分债务类型。筹码贷款为公开：每次立即从对手取得 100 筹码，下一手结束偿还 150；同一手第二次筹码贷款会再取得 100 并再欠 150，两笔按各自到期分别偿还。若对手当前筹码 ≤100，取得其全部剩余筹码并完成贷款斩杀；偿还时若自己因此归零，同样可以斩杀自己。能量贷款为秘密：支付 2 后立即获得 5 能量且不突破个人上限，下一手结束偿还 6；不足时先扣当前能量，剩余形成能量债务，之后任何能量收入优先偿债。只有从玩家筹码或能量中真实扣除才算偿还。公平、比赛结束失效、调试重置、状态覆盖或其他免除都不算实际偿还。公平仍可清除尚未履行或尚未偿清的贷款债务，但不回滚已经取得的筹码或能量；若因此清掉任何金额大于 0 的 pending 或 residual 债务，则视为未经真实偿还的免除：正常信用变为信用受限，已受限则保持受限，已违约则脱离违约但进入信用受限而不是恢复正常。信用受限后，必须完成至少一笔在受限状态下新产生、正常到期、且全部通过真实资源支付、没有任何部分被免除、最终 residual 为 0 的贷款，才能恢复正常信用。违约后若 residual 被真实全部还清，恢复正常信用；若被公平清除，则只升为信用受限。反制抓住贷款时：费用照付，不获得资源，不生成偿还或 residual，不改变信用状态。整场比赛合法结束后，未到期偿还、residual 与信用状态全部清空，下一场从正常信用开始。伪装生效时公开贷款只宣布发动行为，不公布任何筹码或债务数字。",
  }),
  ALERT: freezeSkill({
    id: "ALERT", name: "警觉", load: 1, energyCost: 0,
    tags: [SKILL_TAGS.PASSIVE, SKILL_TAGS.INFORMATION, SKILL_TAGS.SECRET],
    visibility: "SECRET",
    shortDescription: "有时会在自己下次行动前隐约察觉对手做过秘密行动，但不会告诉你那是什么。",
    expertDescription: "被动/完全秘密/情报。负载 1，费用 0。只监听敌方合法、正式提交且仍对自己隐藏的主动技能事件；公开主动技能、被动技能、非法请求、取消和网络重发都不触发。概率阶梯为 10%→25%→40%→55%→70%→85%→100%。漏过一次升一级，成功后重置为 10%。敏锐度跨手保留，当前概率不直接显示。成功后不在技能发生瞬间提示，而在自己下一次合法下注决策开始时显示：“你隐约察觉到对手似乎进行了秘密行动。”不透露名称、类型、数量、费用、结果或精确时间。本手最多成功提示一次。",
  }),
  RETREAT: freezeSkill({
    id: "RETREAT", name: "撤退", load: 2, energyCost: 3,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.DEFENSE, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET", canBeCountered: true,
    shortDescription: "先偷偷准备后路。这手如果你主动弃牌，双方这手丢进锅里的筹码会原路返还，当这手没输没赢。",
    expertDescription: "主动/秘密/防御。负载 2，费用 3，每手最多 1 次，仅能在自己的合法下注行动回合发动。成功建立后，可在当前同一个下注决策窗口立即 Fold，也可保留状态等到本手之后的合法 Fold 窗口使用；不要求提前一街或最小延迟。撤退 Fold 只退还双方本手全部标准下注贡献（含盲注、跟注、加注与标准 ALL IN 贡献），标准净筹码转移为 0，且不获得普通败者 +1。不回滚贷款/终局等直接技能筹码转移、已付能量、已见信息或已完成换牌。若被反制：3 能量已付、状态不得建立、不自动 Fold，玩家仍留在原下注决策窗口。绝路不会清除已有撤退，因此先撤退后绝路仍可撤退 Fold，此时标准净收益为 0，绝路 Fold×3 仍为 0。先绝路则不能再新发动撤退。公平清除撤退且不退 3 能量。恐吓禁止 Fold，因此即使状态仍在也无法触发。终局关闭下注后撤退状态可以仍在，但没有合法 Fold 窗口。撤退 Fold 不触发试探。",
  }),
  RESTART: freezeSkill({
    id: "RESTART", name: "重启", load: 4, energyCost: 3,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.HOLE_EDIT, SKILL_TAGS.DECK_EDIT, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET", canBeCountered: true,
    shortDescription: "把自己的两张底牌一起洗回剩余牌堆，再随机抽两张新的。不保证变好，也有可能抽回原来那两张。",
    expertDescription: "主动/秘密/牌面重构。负载 4，费用 3，每手最多 1 次，任意阶段可发动，包括 River 之后。发动时将自己的两张底牌重新洗入合法剩余牌堆，再随机抽取两张新的底牌；必须两张一起重抽。原两张先进入随机池，因此允许极低概率新两张与原来完全相同，不提供“至少换成不同牌”的保护。完成后的底牌变化属于既定事实，公平不能回滚。必须保持 52 张唯一。",
  }),
  PROBE: freezeSkill({
    id: "PROBE", name: "试探", load: 1, energyCost: 2,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.SETTLEMENT, SKILL_TAGS.SECRET, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "SECRET", canBeCountered: true,
    shortDescription: "如果这手之后对手自己选择普通弃牌，你这手基础赢筹码先加 50，再计算翻倍。",
    expertDescription: "主动/秘密/心理博弈。负载 1，费用 2，每手最多 1 次。发动后建立本手试探状态。若对手之后在本手主动选择普通 Fold：本手基础标准净收益增加 50。这 50 不是独立奖励，必须先并入基础标准收益再参与倍率，例如基础 100、试探成功并有血战则为 (100+50)×2=300。自己的 Fold 不会触发自己的试探。撤退等技能型特殊退出不按普通 Fold 处理。未触发的试探状态可被公平清除。",
  }),
  DISGUISE: freezeSkill({
    id: "DISGUISE", name: "伪装", load: 4, energyCost: 2,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "PUBLIC", canBeCountered: true,
    shortDescription: "这手让对手看不到双方筹码数字和具体下注金额，只能看见有人下注。你自己始终知道自己有没有全押。",
    expertDescription: "主动/公开/筹码信息控制。负载 4，费用 2，每手最多 1 次。必须从玩家专属视图模型裁剪一切可反推筹码的数值，包括双方剩余筹码、本手投入、底池、Bet/Call/Raise 金额、最小加注、需补筹码，以及任何“余额不足 XXX”提示，不能只靠 CSS 遮挡。单方发动时发动者视角正常；受影响玩家的 Call 按钮不得带金额，Raise 不得显示最小加注数字。超额输入按真实最大可投入自动封顶为合法 ALL IN，不返回筹码不足数字。玩家始终知道自己是否实际进入 ALL IN；普通 ALL IN 对对手只显示普通对应动作。双方都发动时进入黑暗筹码状态，仍各自知道自己的 ALL IN。绝路 ALL IN 强制公开。灵视不能穿透筹码数值。公开技能不触发警觉。公平清除后恢复未来视图，但不回填已经隐藏时刻的历史数值日志。",
  }),
  ENDGAME: freezeSkill({
    id: "ENDGAME", name: "终局", load: 6, energyCost: 8,
    tags: [SKILL_TAGS.ACTIVE, SKILL_TAGS.CONTROL, SKILL_TAGS.SETTLEMENT, SKILL_TAGS.ONCE_PER_HAND],
    allowedPhases: ACTIVE_STREETS, maxUsesPerHand: 1, requiresActionTurn: true, visibility: "PUBLIC", canBeCountered: true,
    shortDescription: "立刻锁住已经对齐的下注，没收对手多出来的那部分筹码，然后停止再下注、发完公共牌并强制摊牌。若对手已经全押归零，同级牌型由你直接斩杀。",
    expertDescription: "主动/公开/超级技能。负载 6，费用 8，首发唯一 6 负载技能，每手最多 1 次。可在自己的合法下注窗口公开发动，包括正在面对 Bet、Raise 或普通 ALL IN，以及对手 Call 至 0 后的专属响应窗口。该专属窗口只给予刚刚造成 Call-to-zero 的进攻方，不按座位顺序，双方不能同时获得。窗口必须提供明确的发动 / 放弃选择；超时视为放弃。Bot 必须按自身可见牌力判断是否发动，不得无脑自动发动。结算顺序必须为：合法性 → 支付 8 → 处理反制 → 成功公开 → 计算匹配/未匹配 → 仅没收对手未匹配标准贡献（直接技能筹码转移，不进倍率） → 按发动前真实剩余筹码是否已为 0 记录处决资格 → 发完公共牌 → Showdown。发动者自己多出的未匹配下注按普通德州退还，不得进入没收池。反制命中则 8 能量已付且失败，不得没收、不得关下注、不得进入处决。处决只看对手因真实标准 ALL IN 或 Call-to-zero 导致 remaining chips==0。处决按正式牌型等级比较：皇家同花顺 10 高于同花顺 9，不同等级正常比较；仅当双方牌型等级完全相同时发动者直接获胜。专属斩杀表现只在处决覆盖了普通内部牌力比较时触发（endgameExecutionOverride）。公平已生效时不可发动；已完成的直接没收不能被公平回滚。",
  }),
  PROTOCOL_HIGH_CARD: protocolSkill(
    "PROTOCOL_HIGH_CARD", "协议--高牌", PROTOCOL_CATEGORIES.HIGH_CARD,
    "摊牌时如果你最终就是高牌并且赢了，净赢筹码翻倍。",
  ),
  PROTOCOL_PAIR: protocolSkill(
    "PROTOCOL_PAIR", "协议--对子", PROTOCOL_CATEGORIES.PAIR,
    "摊牌时如果你最终刚好是一对并且赢了，净赢筹码翻倍。",
  ),
  PROTOCOL_TWO_PAIR: protocolSkill(
    "PROTOCOL_TWO_PAIR", "协议--两对", PROTOCOL_CATEGORIES.TWO_PAIR,
    "摊牌时如果你最终刚好是两对并且赢了，净赢筹码翻倍。",
  ),
  PROTOCOL_TRIPS: protocolSkill(
    "PROTOCOL_TRIPS", "协议--三条", PROTOCOL_CATEGORIES.TRIPS,
    "摊牌时如果你最终刚好是三条并且赢了，净赢筹码翻倍。",
  ),
  PROTOCOL_STRAIGHT: protocolSkill(
    "PROTOCOL_STRAIGHT", "协议--顺子", PROTOCOL_CATEGORIES.STRAIGHT,
    "摊牌时如果你最终刚好是顺子并且赢了，净赢筹码翻倍。",
  ),
  PROTOCOL_FLUSH: protocolSkill(
    "PROTOCOL_FLUSH", "协议--同花", PROTOCOL_CATEGORIES.FLUSH,
    "摊牌时如果你最终刚好是同花并且赢了，净赢筹码翻倍。",
  ),
  PROTOCOL_FULL_HOUSE: protocolSkill(
    "PROTOCOL_FULL_HOUSE", "协议--葫芦", PROTOCOL_CATEGORIES.FULL_HOUSE,
    "摊牌时如果你最终刚好是葫芦并且赢了，净赢筹码翻倍。",
  ),
  PROTOCOL_QUADS: protocolSkill(
    "PROTOCOL_QUADS", "协议--四条", PROTOCOL_CATEGORIES.QUADS,
    "摊牌时如果你最终刚好是四条并且赢了，净赢筹码翻倍。",
  ),
  PROTOCOL_STRAIGHT_FLUSH: protocolSkill(
    "PROTOCOL_STRAIGHT_FLUSH", "协议--同花顺", PROTOCOL_CATEGORIES.STRAIGHT_FLUSH,
    "摊牌时如果你最终刚好是同花顺并且赢了，净赢筹码翻倍。皇家同花顺也按同花顺协议处理。",
    "皇家同花顺当前不单独建立协议；若牌型系统把皇家同花顺视作同花顺，则由本协议处理。",
  ),
});

const PUBLIC_SKILL_CATALOG = Object.freeze(Object.values(SKILL_DEFINITIONS).map((skill) => Object.freeze({
  id: skill.id,
  name: skill.name,
  load: skill.load,
  energyCost: skill.energyCost,
  energyCosts: skill.energyCosts,
  tags: skill.tags,
  allowedPhases: skill.allowedPhases,
  maxUsesPerHand: skill.maxUsesPerHand,
  maxUsesPerGame: skill.maxUsesPerGame,
  requiresActionTurn: skill.requiresActionTurn,
  requiresFirstSkillEvent: skill.requiresFirstSkillEvent,
  canBeCountered: skill.canBeCountered,
  visibility: skill.visibility,
  protocolCategory: skill.protocolCategory,
  description: skill.description,
  shortDescription: skill.shortDescription,
  expertDescription: skill.expertDescription,
})));

function getSkillDefinition(skillId) {
  return SKILL_DEFINITIONS[String(skillId || "").trim().toUpperCase()] || null;
}
function listSkillDefinitions() { return PUBLIC_SKILL_CATALOG; }
function isCardEditSkill(skill) { return Boolean(skill?.tags?.some((tag) => CARD_EDIT_TAGS.includes(tag))); }
function isActiveSkill(skill) { return Boolean(skill?.tags?.includes(SKILL_TAGS.ACTIVE)); }
function isPassiveSkill(skill) { return Boolean(skill?.tags?.includes(SKILL_TAGS.PASSIVE)); }
function isInformationSkill(skill) { return Boolean(skill?.tags?.includes(SKILL_TAGS.INFORMATION)); }
function isProtocolSkill(skill) { return Boolean(skill?.tags?.includes(SKILL_TAGS.PROTOCOL)); }
function protocolMatchesCategory(protocolCategory, handCategory) {
  if (protocolCategory == null || handCategory == null) return false;
  if (protocolCategory === PROTOCOL_CATEGORIES.STRAIGHT_FLUSH) {
    return handCategory === 9 || handCategory === 10;
  }
  return protocolCategory === handCategory;
}

module.exports = {
  SKILL_DEFINITIONS, PUBLIC_SKILL_CATALOG, getSkillDefinition, listSkillDefinitions,
  isCardEditSkill, isActiveSkill, isPassiveSkill, isInformationSkill, isProtocolSkill,
  protocolMatchesCategory, ACTIVE_STREETS,
};
