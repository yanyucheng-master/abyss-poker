"use strict";

// Player-facing source of truth for the in-game V1.0 rulebook.
// Keep implementation names, transport fields and audit-only terminology out of this file.
const OVERLIMIT_RULEBOOK_V1 = Object.freeze({
  version: "1.0",
  title: "超限德州规则手册",
  sections: Object.freeze([
    {
      id: "rule-overview",
      number: "01",
      title: "游戏概述",
      shortTitle: "游戏概述",
      keywords: "OVERLIMIT HOLD'EM 超限德州 双人 无限注 德州扑克 heads-up 1000 25 50",
      content: `
        <p><strong>《超限德州 / OVERLIMIT: HOLD'EM》</strong>是一款以双人无限注德州扑克为基础的策略对战游戏。</p>
        <p>双方通过下注、弃牌与摊牌争夺筹码。启用技能系统时，玩家还可使用赛前构筑的技能影响资源、信息、牌面、牌堆、行动与最终结算。</p>
        <div class="rules-table-wrap">
          <table class="rules-table">
            <caption>基础参数</caption>
            <tbody>
              <tr><th scope="row">对局人数</th><td>2 人</td></tr>
              <tr><th scope="row">初始筹码</th><td>每人 1000</td></tr>
              <tr><th scope="row">小盲注 / 大盲注</th><td>25 / 50</td></tr>
              <tr><th scope="row">初始能量 / 普通上限</th><td>4 / 8</td></tr>
              <tr><th scope="row">技能构筑</th><td>1～4 个技能，总负载不超过 8</td></tr>
            </tbody>
          </table>
        </div>
        <p>任意一方筹码归零后，比赛结束，另一方获得本场胜利。筹码只在玩家之间或玩家与底池之间转移；除规则明确规定外，全场筹码总量始终为 2000。</p>
        <aside class="rules-note">牌型基础奖励与基础筹码经济适用于所有游戏模式，与技能系统是否开启无关。</aside>
      `,
    },
    {
      id: "rule-modes",
      number: "02",
      title: "游戏模式",
      shortTitle: "游戏模式",
      keywords: "标准局 高爆局 标准牌堆 强牌 河牌反超 技能关闭 技能开启 standard overdrive skill",
      content: `
        <p>发牌模式与技能模式相互独立。玩家可分别选择牌堆类型与是否启用技能。</p>
        <section id="rule-mode-standard" data-rule-entry data-rule-entry-title="标准局">
          <h4>标准局</h4>
          <p>使用完整 52 张牌的标准随机牌堆。采用双人无限注德州扑克的发牌、下注、牌型与摊牌规则，并使用《超限德州》的牌型奖励与基础经济规则。</p>
        </section>
        <section id="rule-mode-overdrive" data-rule-entry data-rule-entry-title="高爆局">
          <h4>高爆局</h4>
          <p>采用强化的初始牌堆生成机制，使牌局更倾向于出现强牌对抗、河牌升级、河牌反超及高强度成牌。高爆局不改变下注、筹码、牌型、摊牌或牌型奖励规则；技能改变牌堆后，也不会重新生成候选牌局。</p>
        </section>
        <section id="rule-mode-skills" data-rule-entry data-rule-entry-title="技能开启与关闭">
          <h4>技能开启与关闭</h4>
          <p><strong>技能关闭：</strong>不启用技能构筑、能量消耗及技能效果。牌型基础奖励仍然生效。</p>
          <p><strong>技能开启：</strong>玩家在比赛开始前完成构筑，并在标准牌局基础上使用技能、能量与特殊结算规则。</p>
        </section>
      `,
    },
    {
      id: "rule-blinds",
      number: "03",
      title: "庄家、盲注与行动顺序",
      shortTitle: "庄家与盲注",
      keywords: "庄家 dealer button 小盲 small blind 大盲 big blind 行动顺序 heads-up 25 50",
      content: `
        <p>每手牌开始时，一名玩家位于庄家位并支付小盲注 25，另一名玩家支付大盲注 50。盲注属于标准下注贡献并进入该手底池。</p>
        <div class="rules-callout-grid">
          <div><span>翻牌前</span><strong>庄家位（小盲位）先行动</strong></div>
          <div><span>翻牌、转牌、河牌</span><strong>大盲位先行动</strong></div>
        </div>
        <p>每手结束后庄家位置交换，因此双方轮流担任小盲位与大盲位。</p>
      `,
    },
    {
      id: "rule-flow",
      number: "04",
      title: "牌局流程",
      shortTitle: "牌局流程",
      keywords: "翻牌前 pre-flop preflop 翻牌 flop 转牌 turn 河牌 river 摊牌 showdown 底牌 公共牌 发牌",
      content: `
        <p>每名玩家获得 2 张仅本人可见的底牌。公共牌最多发出 5 张，由双方共同使用。</p>
        <ol class="rules-timeline">
          <li><span>01</span><div><strong>翻牌前（Pre-Flop）</strong><p>仅持有底牌，进行第一轮下注。</p></div></li>
          <li><span>02</span><div><strong>翻牌（Flop）</strong><p>发出 3 张公共牌，进行第二轮下注。</p></div></li>
          <li><span>03</span><div><strong>转牌（Turn）</strong><p>发出第 4 张公共牌，进行第三轮下注。</p></div></li>
          <li><span>04</span><div><strong>河牌（River）</strong><p>发出第 5 张公共牌，进行第四轮下注。</p></div></li>
          <li><span>05</span><div><strong>摊牌（Showdown）</strong><p>双方均未弃牌时，比较各自最佳 5 张牌。</p></div></li>
        </ol>
        <p>一个下注阶段在仍参与该手的玩家完成合法行动，并使标准投入达到当前规则要求后结束。若双方已无后续下注空间，例如一方全下且投入已匹配，系统将自动发出剩余公共牌并进入摊牌。</p>
      `,
    },
    {
      id: "rule-actions",
      number: "05",
      title: "玩家行动",
      shortTitle: "玩家行动",
      keywords: "过牌 check 下注 bet 跟注 call 加注 raise 弃牌 fold 全下 all in timeout 超时 最小加注",
      content: `
        <p>轮到玩家行动时，只能执行系统依据当前牌局状态提供的合法操作。</p>
        <dl class="rules-dl rules-action-list">
          <div id="rule-action-check" data-rule-entry data-rule-entry-title="过牌 Check"><dt>过牌 <span>Check</span></dt><dd>当前无需跟注时，不增加筹码投入并结束本次行动。</dd></div>
          <div id="rule-action-bet" data-rule-entry data-rule-entry-title="下注 Bet"><dt>下注 <span>Bet</span></dt><dd>本街尚无人下注时投入筹码。通常情况下，标准最小下注额为当前大盲注额。</dd></div>
          <div id="rule-action-call" data-rule-entry data-rule-entry-title="跟注 Call"><dt>跟注 <span>Call</span></dt><dd>补足差额，使本街投入与对手当前标准下注匹配；剩余筹码不足时，以全下支付能够支付的部分。</dd></div>
          <div id="rule-action-raise" data-rule-entry data-rule-entry-title="加注 Raise"><dt>加注 <span>Raise</span></dt><dd>提高当前下注额。通常情况下，加注增量不得低于本轮此前最近一次完整下注或完整加注的增量。未达到完整加注幅度的全下不会重新开放已完成行动玩家的加注权。</dd></div>
          <div id="rule-action-fold" data-rule-entry data-rule-entry-title="弃牌 Fold"><dt>弃牌 <span>Fold</span></dt><dd>放弃当前手牌，对手立即获胜，不再比较牌型。</dd></div>
          <div id="rule-action-allin" data-rule-entry data-rule-entry-title="全下 All In"><dt>全下 <span>All In</span></dt><dd>投入当前规则允许的最大筹码。未匹配部分按第 13 章处理。</dd></div>
        </dl>
        <section id="rule-action-timeout" data-rule-entry data-rule-entry-title="行动超时">
          <h4>行动超时</h4>
          <p>每个真人行动回合均设有服务器倒计时。超时时，若当前可以合法过牌，系统自动过牌；否则系统自动弃牌。</p>
        </section>
      `,
    },
    {
      id: "rule-showdown",
      number: "06",
      title: "手牌胜负与摊牌",
      shortTitle: "胜负与摊牌",
      keywords: "弃牌胜利 fold 摊牌 showdown 最佳五张 best five 七张 底牌 公共牌 平局 tie kicker",
      content: `
        <section id="rule-win-by-fold" data-rule-entry data-rule-entry-title="弃牌胜利">
          <h4>弃牌胜利</h4>
          <p>一名玩家弃牌后，对手立即赢得该手。弃牌结束的手牌不比较牌型，也不获得牌型基础奖励。</p>
        </section>
        <section id="rule-showdown-best-five" data-rule-entry data-rule-entry-title="摊牌与最佳五张">
          <h4>摊牌与最佳五张</h4>
          <p>双方均未弃牌并完成最终下注后进入摊牌。每名玩家从本人的 2 张底牌与桌面的 5 张公共牌中，选出能够组成最高牌型的 5 张牌。</p>
          <p>玩家可以使用 0 张、1 张或 2 张底牌。最终最佳 5 张牌较强的一方获胜；若双方最佳 5 张完全相同，则为平局。</p>
        </section>
        <aside class="rules-note">所有花色地位相同，不存在花色高低。</aside>
      `,
    },
    {
      id: "rule-hands",
      number: "07",
      title: "牌型与同类牌型比较",
      shortTitle: "牌型",
      keywords: "皇家同花顺 royal flush 同花顺 straight flush 四条 quads 葫芦 full house 同花 flush 顺子 straight 三条 trips 两对 two pair 一对 pair 高牌 high card A2345",
      content: `
        <p>牌型由高至低排列如下。皇家同花顺在本系统中属于独立牌型等级，高于普通同花顺。</p>
        <div class="rules-hand-grid">
          <section id="hand-royal-flush" class="rules-hand-item" data-rule-entry data-rule-entry-title="皇家同花顺 Royal Flush"><div class="rules-hand-rank">01</div><div><h4>皇家同花顺 <span>Royal Flush</span></h4><p>同一花色的 A、K、Q、J、10。</p><div class="rules-card-example" aria-label="A黑桃 K黑桃 Q黑桃 J黑桃 10黑桃"><b>A♠</b><b>K♠</b><b>Q♠</b><b>J♠</b><b>10♠</b></div></div></section>
          <section id="hand-straight-flush" class="rules-hand-item" data-rule-entry data-rule-entry-title="同花顺 Straight Flush"><div class="rules-hand-rank">02</div><div><h4>同花顺 <span>Straight Flush</span></h4><p>5 张同一花色且点数连续的牌。同牌型比较最高张。</p><div class="rules-card-example"><b>9♣</b><b>8♣</b><b>7♣</b><b>6♣</b><b>5♣</b></div></div></section>
          <section id="hand-quads" class="rules-hand-item" data-rule-entry data-rule-entry-title="四条 Four of a Kind"><div class="rules-hand-rank">03</div><div><h4>四条 <span>Four of a Kind</span></h4><p>先比较四条点数；相同则比较剩余单张。</p><div class="rules-card-example"><b>9♠</b><b class="is-red">9♥</b><b class="is-red">9♦</b><b>9♣</b><b>K♠</b></div></div></section>
          <section id="hand-full-house" class="rules-hand-item" data-rule-entry data-rule-entry-title="葫芦 Full House"><div class="rules-hand-rank">04</div><div><h4>葫芦 <span>Full House</span></h4><p>三条加一对。先比较三条点数，再比较对子点数。</p><div class="rules-card-example"><b>K♠</b><b class="is-red">K♥</b><b class="is-red">K♦</b><b>4♣</b><b class="is-red">4♥</b></div></div></section>
          <section id="hand-flush" class="rules-hand-item" data-rule-entry data-rule-entry-title="同花 Flush"><div class="rules-hand-rank">05</div><div><h4>同花 <span>Flush</span></h4><p>5 张同一花色但不构成同花顺。由最高张开始依次比较。</p><div class="rules-card-example"><b class="is-red">A♥</b><b class="is-red">J♥</b><b class="is-red">8♥</b><b class="is-red">5♥</b><b class="is-red">2♥</b></div></div></section>
          <section id="hand-straight" class="rules-hand-item" data-rule-entry data-rule-entry-title="顺子 Straight"><div class="rules-hand-rank">06</div><div><h4>顺子 <span>Straight</span></h4><p>5 张点数连续、花色不限的牌。同为顺子时比较最高张。</p><div class="rules-card-example"><b>9♠</b><b class="is-red">8♥</b><b class="is-red">7♦</b><b>6♣</b><b>5♠</b></div></div></section>
          <section id="hand-trips" class="rules-hand-item" data-rule-entry data-rule-entry-title="三条 Three of a Kind"><div class="rules-hand-rank">07</div><div><h4>三条 <span>Three of a Kind</span></h4><p>先比较三条点数，再依次比较两张单牌。</p><div class="rules-card-example"><b>7♠</b><b class="is-red">7♥</b><b class="is-red">7♦</b><b>A♣</b><b>10♠</b></div></div></section>
          <section id="hand-two-pair" class="rules-hand-item" data-rule-entry data-rule-entry-title="两对 Two Pair"><div class="rules-hand-rank">08</div><div><h4>两对 <span>Two Pair</span></h4><p>依次比较较高对子、较低对子与剩余单张。</p><div class="rules-card-example"><b>Q♠</b><b class="is-red">Q♥</b><b class="is-red">4♦</b><b>4♣</b><b>A♠</b></div></div></section>
          <section id="hand-pair" class="rules-hand-item" data-rule-entry data-rule-entry-title="一对 One Pair"><div class="rules-hand-rank">09</div><div><h4>一对 <span>One Pair</span></h4><p>先比较对子点数，再依次比较 3 张单牌。</p><div class="rules-card-example"><b>J♠</b><b class="is-red">J♥</b><b>A♣</b><b class="is-red">8♦</b><b>3♠</b></div></div></section>
          <section id="hand-high-card" class="rules-hand-item" data-rule-entry data-rule-entry-title="高牌 High Card"><div class="rules-hand-rank">10</div><div><h4>高牌 <span>High Card</span></h4><p>未组成以上牌型时，由最高张开始依次比较最佳 5 张。</p><div class="rules-card-example"><b>A♠</b><b class="is-red">J♦</b><b>9♣</b><b class="is-red">6♥</b><b>3♠</b></div></div></section>
        </div>
        <aside class="rules-note"><strong>A 的顺子规则：</strong>A 可用于 A-K-Q-J-10，也可在 A-2-3-4-5 中作为最低点数；不能环绕形成 Q-K-A-2-3。花色不参与牌型高低比较。</aside>
      `,
    },
    {
      id: "rule-bonus",
      number: "08",
      title: "牌型基础奖励",
      shortTitle: "牌型奖励",
      keywords: "所有模式共享 基础规则 牌型奖励 hand rank bonus showdown fold retreat tie +25 +50 +75 +100 +250 +400 +500",
      content: `
        <div class="rules-rule-tag">所有模式共享的基础规则</div>
        <p>仅在摊牌产生唯一胜者时，按胜者最终最佳 5 张的牌型发放。奖励由败方向胜者追加支付，加入标准结算基础值后再计算合法倍率，因此不会增加全场筹码总量。</p>
        <div class="rules-table-wrap">
          <table class="rules-table rules-bonus-table">
            <caption>获胜牌型与基础奖励</caption>
            <thead><tr><th>牌型</th><th>奖励</th><th>牌型</th><th>奖励</th></tr></thead>
            <tbody>
              <tr><th scope="row">高牌</th><td>+0</td><th scope="row">同花</th><td>+75</td></tr>
              <tr><th scope="row">一对</th><td>+0</td><th scope="row">葫芦</th><td>+100</td></tr>
              <tr><th scope="row">两对</th><td>+0</td><th scope="row">四条</th><td>+250</td></tr>
              <tr><th scope="row">三条</th><td>+25</td><th scope="row">同花顺</th><td>+400</td></tr>
              <tr><th scope="row">顺子</th><td>+50</td><th scope="row">皇家同花顺</th><td>+500</td></tr>
            </tbody>
          </table>
        </div>
        <aside class="rules-note">普通弃牌、撤退弃牌与平局均不获得牌型基础奖励。若败方筹码不足，最终实际支付不超过败方可支付筹码。</aside>
      `,
    },
    {
      id: "rule-loadout",
      number: "09",
      title: "技能构筑",
      shortTitle: "技能构筑",
      keywords: "技能构筑 loadout 装备 负载 槽位 1至4 1～4 上限8 不可重复 协议 隐藏构筑",
      content: `
        <p>启用技能系统时，玩家须在比赛开始前完成构筑。构筑一经确认，本场比赛中不可更换。</p>
        <div class="rules-callout-grid rules-callout-grid-three">
          <div><span>技能数量</span><strong>1～4 个</strong></div>
          <div><span>总负载</span><strong>不超过 8</strong></div>
          <div><span>重复装备</span><strong>不允许</strong></div>
        </div>
        <p>协议技能同样占用技能槽位与负载。比赛开始时，对手不会获知你的装备数量、总负载或完整技能列表；技能可按自身可见性与实际事件逐步暴露。</p>
      `,
    },
    {
      id: "rule-energy",
      number: "10",
      title: "能量与公开能量",
      shortTitle: "能量",
      keywords: "真实能量 公开能量 public energy 初始4 上限8 天命10 强运-4 负能量 败者恢复 灵视",
      content: `
        <section id="rule-energy-real" data-rule-entry data-rule-entry-title="真实能量">
          <h4>真实能量</h4>
          <p>普通构筑开局能量为 4，上限为 8。装备「天命」时，本人的真实上限提高至 10。「强运」允许真实能量最低降至 -4；真实能量低于 0 时，除强运外不能发动新的主动技能，也不能触发新的被动技能事件。</p>
        </section>
        <section id="rule-energy-recovery" data-rule-entry data-rule-entry-title="手牌结束自然恢复">
          <h4>手牌结束自然恢复</h4>
          <div class="rules-table-wrap"><table class="rules-table"><thead><tr><th>手牌结果</th><th>自然恢复</th></tr></thead><tbody><tr><th scope="row">获胜</th><td>+0</td></tr><tr><th scope="row">失败或普通弃牌</th><td>+1</td></tr><tr><th scope="row">平局</th><td>+0</td></tr><tr><th scope="row">撤退弃牌</th><td>+0</td></tr></tbody></table></div>
          <p>技能造成的额外恢复、支付、借贷、债务或恢复抑制另行结算。</p>
        </section>
        <section id="rule-energy-public" data-rule-entry data-rule-entry-title="对手公开能量">
          <h4>对手公开能量</h4>
          <p>对手能量按“逐手公开、手内冻结”显示：一手结束并完成全部资源结算后更新，下一手进行期间保持不变。普通公开范围为 0～8；真实值低于 0 时显示 0，9 或 10 时显示 8。</p>
          <p>玩家始终可查看自己的真实当前能量。「灵视」等具有资源侦察效果的技能可以读取对手真实当前能量。</p>
        </section>
      `,
    },
    {
      id: "rule-skill-general",
      number: "11",
      title: "技能通则",
      shortTitle: "技能通则",
      keywords: "主动技能 被动技能 公开 秘密 技能事件 既定事实 反制 绝密 公平 legality trigger visibility",
      content: `
        <section id="rule-active-skills" data-rule-entry data-rule-entry-title="主动技能">
          <h4>主动技能</h4>
          <p>主动技能须处于允许阶段与行动窗口，并满足目标、次数、能量及其他条件。合法发动后先支付费用，再进入技能结算。除技能另有规定外，主动技能可以被「反制」。</p>
        </section>
        <section id="rule-passive-skills" data-rule-entry data-rule-entry-title="被动技能">
          <h4>被动技能</h4>
          <p>被动技能在满足条件时由系统自动判定。未真正触发的被动能力不视为技能事件。</p>
        </section>
        <section id="rule-skill-visibility" data-rule-entry data-rule-entry-title="公开与秘密">
          <h4>公开与秘密</h4>
          <p><strong>公开技能</strong>的发动及主要结果向双方公开。<strong>秘密技能</strong>默认只向发动者或持有者提供具体结果；若其效果产生规则规定的公开结果，对手可据此确认相应技能。</p>
        </section>
        <section id="rule-skill-events" data-rule-entry data-rule-entry-title="技能事件与既定事实">
          <h4>技能事件与既定事实</h4>
          <p>一次合法、已支付费用并进入结算的主动发动，或一次真正触发的被动效果，视为技能事件。已经获得的信息、已经完成的换牌或牌堆修改、已经完成的直接筹码转移均属于既定事实；后续清除状态不会自动回滚这些事实。</p>
        </section>
        <section id="rule-counter-general" data-rule-entry data-rule-entry-title="反制总则">
          <h4>反制总则</h4>
          <p>反制捕获对手下一次合法且已经支付费用的主动技能。非法请求、取消、重复网络请求与未触发的被动效果不会消耗反制。「公平」不能被反制。</p>
        </section>
        <section id="rule-top-secret-general" data-rule-entry data-rule-entry-title="绝密总则">
          <h4>绝密总则</h4>
          <p>绝密保护持有者底牌的私人信息及直接操作，包括读取、推断、交换、零化或直接影响底牌。公共牌情报、灵视及纯技能元信息不受绝密保护。</p>
        </section>
        <section id="rule-fairness-general" data-rule-entry data-rule-entry-title="公平总则">
          <h4>公平总则</h4>
          <p>公平清除双方当前仍存在的持续、预埋及待结算技能状态，并封锁本手之后新的主动与被动技能事件，同时抑制该手结束时的全部能量恢复。公平不会回滚已经完成的信息、改牌、牌堆修改或直接筹码转移。</p>
        </section>
      `,
    },
    {
      id: "rule-settlement",
      number: "12",
      title: "筹码、底池与结算",
      shortTitle: "筹码结算",
      keywords: "筹码 底池 标准下注贡献 直接技能转移 结算顺序 倍率 防守 整数 零和 loss cap",
      content: `
        <section id="rule-standard-contribution" data-rule-entry data-rule-entry-title="标准下注贡献">
          <h4>标准下注贡献</h4>
          <p>盲注、下注、跟注、加注与标准全下投入属于标准下注贡献，进入底池并参与正常牌局结算。</p>
        </section>
        <section id="rule-direct-transfer" data-rule-entry data-rule-entry-title="直接技能筹码转移">
          <h4>直接技能筹码转移</h4>
          <p>贷款取得与偿还、终局没收的未匹配投入，以及其他明确标注为直接转移的效果，不属于标准底池收益。除技能明确规定外，它们不参与普通筹码倍率，也不受防守保护。</p>
        </section>
        <section id="rule-settlement-order" data-rule-entry data-rule-entry-title="标准结算顺序">
          <h4>标准结算顺序</h4>
          <ol class="rules-steps rules-numbered-steps">
            <li>确定标准德州扑克净筹码转移；</li>
            <li>加入牌型基础奖励；</li>
            <li>加入其他合法基础加值，例如「试探」；</li>
            <li>计算胜方本人产生的合法技能倍率；</li>
            <li>计算对手产生的合法倍率；</li>
            <li>应用「防守」等最终标准损失修正；</li>
            <li>以败方实际可支付筹码为上限；</li>
            <li>完成最终整数筹码转移。</li>
          </ol>
        </section>
        <section id="rule-settlement-multipliers" data-rule-entry data-rule-entry-title="倍率与防守">
          <h4>倍率与防守</h4>
          <p>血战 ×2、双方血战 ×4、绝境获胜 ×3、绝路使对手普通弃牌 ×3、符合条件的协议 ×2。多个合法倍率按规则乘法叠加。</p>
          <p>若本手已有胜方本人其他技能产生的筹码倍率，本人的协议不触发；对手产生的倍率不阻止协议。防守在基础收益、加值与倍率之后处理，使最终标准净损失取原目标损失的一半并向下取整。</p>
        </section>
        <aside class="rules-note">正式筹码状态均为整数，最小单位为 1。任何最终转移都不得使支付方筹码低于 0。</aside>
      `,
    },
    {
      id: "rule-allin",
      number: "13",
      title: "全下与未匹配投入",
      shortTitle: "全下",
      keywords: "全下 ALL IN all-in unmatched 未匹配投入 退还 边池 side pot 自动发牌 摊牌 终局",
      content: `
        <p>全下表示投入当前规则允许的最大筹码。玩家全下后，如双方均已无合法后续下注行动，系统自动发出剩余公共牌并进入摊牌。</p>
        <section id="rule-unmatched-bet" data-rule-entry data-rule-entry-title="未匹配投入">
          <h4>未匹配投入</h4>
          <p>双人牌局中，只有双方能够相互匹配的标准投入参与正常争夺。一方超过对手可匹配范围的未匹配标准投入，在摊牌前退回原玩家。</p>
        </section>
        <section id="rule-no-side-pots" data-rule-entry data-rule-entry-title="双人底池">
          <h4>双人底池</h4>
          <p>《超限德州》不采用多人德州扑克中的多重边池体系。「终局」可以明确改变对手未匹配投入的处理方式，详见主体技能与关键交互章节。</p>
        </section>
      `,
    },
    {
      id: "rule-skills",
      number: "14",
      title: "主体技能",
      shortTitle: "主体技能",
      keywords: "24个 主体技能 skill archive 深呼吸 终局 贷款 零化 强运 感知",
      content: "",
      kind: "skills",
    },
    {
      id: "rule-protocols",
      number: "15",
      title: "协议技能",
      shortTitle: "协议",
      keywords: "9个 协议 protocol 高牌 对子 两对 三条 顺子 同花 葫芦 四条 同花顺 皇家同花顺",
      content: "",
      kind: "protocols",
    },
    {
      id: "rule-interactions",
      number: "16",
      title: "关键交互裁定",
      shortTitle: "关键交互",
      keywords: "公平 反制 贷款 撤退 伪装 终局 零化 灵视 警觉 绝路 试探 恐吓 绝密 天命 千术 interaction",
      content: `
        <p>下表列出首发规则中容易产生歧义的正式交互。已完成事实与仍在持续的状态必须区分处理。</p>
        <div class="rules-table-wrap">
          <table class="rules-table rules-interaction-table">
            <thead><tr><th>交互</th><th>裁定</th></tr></thead>
            <tbody>
              <tr id="interaction-fair-counter" data-rule-entry data-rule-entry-title="公平 × 反制"><th scope="row">公平 × 反制</th><td>公平不能被反制。</td></tr>
              <tr id="interaction-fair-loan" data-rule-entry data-rule-entry-title="公平 × 贷款"><th scope="row">公平 × 贷款</th><td>清除未偿状态但不退回已取得资源；若实际清除债务，信用进入或保持受限。违约状态只恢复到信用受限，不直接恢复正常。</td></tr>
              <tr id="interaction-fair-retreat" data-rule-entry data-rule-entry-title="公平 × 撤退"><th scope="row">公平 × 撤退</th><td>清除撤退状态，已支付的 3 点能量不退；公平生效后本手不能再新发动撤退。</td></tr>
              <tr id="interaction-fair-disguise" data-rule-entry data-rule-entry-title="公平 × 伪装"><th scope="row">公平 × 伪装</th><td>清除伪装，只恢复之后的信息显示，不补填此前隐藏的历史数值。</td></tr>
              <tr id="interaction-fair-endgame" data-rule-entry data-rule-entry-title="公平 × 终局"><th scope="row">公平 × 终局</th><td>公平已成功时不能再发动终局；终局已关闭下注后不再产生普通公平窗口；已经完成的终局没收不回滚。</td></tr>
              <tr id="interaction-fair-nullification" data-rule-entry data-rule-entry-title="公平 × 零化"><th scope="row">公平 × 零化</th><td>零化属于持续状态，可以被公平清除。</td></tr>
              <tr id="interaction-disguise-clairvoyance" data-rule-entry data-rule-entry-title="伪装 × 灵视"><th scope="row">伪装 × 灵视</th><td>灵视可以知道伪装已经发生，但不能读取具体筹码、底池或下注数字。</td></tr>
              <tr id="interaction-disguise-alert" data-rule-entry data-rule-entry-title="伪装 × 警觉"><th scope="row">伪装 × 警觉</th><td>伪装属于公开主动技能，不触发警觉。</td></tr>
              <tr id="interaction-disguise-loan" data-rule-entry data-rule-entry-title="伪装 × 贷款"><th scope="row">伪装 × 贷款</th><td>筹码贷款仍公开宣布发动，但不公布取得、欠款或斩杀数字。</td></tr>
              <tr id="interaction-disguise-deadend" data-rule-entry data-rule-entry-title="伪装 × 绝路"><th scope="row">伪装 × 绝路</th><td>绝路产生的全下始终强制公开。</td></tr>
              <tr id="interaction-retreat-deadend" data-rule-entry data-rule-entry-title="撤退 × 绝路"><th scope="row">撤退 × 绝路</th><td>先建立撤退再发动绝路，仍可在合法窗口撤退；先发动绝路后，不能再新发动撤退。撤退使标准净转移为 0，绝路的 0 × 3 仍为 0。</td></tr>
              <tr id="interaction-retreat-probe" data-rule-entry data-rule-entry-title="撤退 × 试探"><th scope="row">撤退 × 试探</th><td>撤退弃牌不是普通弃牌，不触发试探。</td></tr>
              <tr id="interaction-retreat-intimidation" data-rule-entry data-rule-entry-title="撤退 × 恐吓"><th scope="row">撤退 × 恐吓</th><td>恐吓禁止弃牌，因此不能完成撤退弃牌。</td></tr>
              <tr id="interaction-retreat-endgame" data-rule-entry data-rule-entry-title="撤退 × 终局"><th scope="row">撤退 × 终局</th><td>终局关闭下注后不再存在弃牌窗口；已有撤退状态不必删除，但无法使用。</td></tr>
              <tr id="interaction-endgame-counter" data-rule-entry data-rule-entry-title="终局 × 反制"><th scope="row">终局 × 反制</th><td>终局先支付 8 点能量，再处理反制。被反制后不没收、不关闭下注、不进入处决。</td></tr>
              <tr id="interaction-endgame-multiplier" data-rule-entry data-rule-entry-title="终局 × 倍率"><th scope="row">终局 × 倍率</th><td>终局直接没收不参与血战、绝境、协议等标准收益倍率。</td></tr>
              <tr id="interaction-endgame-protocol" data-rule-entry data-rule-entry-title="终局 × 协议"><th scope="row">终局 × 协议</th><td>终局确定最终胜方后，协议仍按胜方最终牌型与协议条件独立判定。</td></tr>
              <tr id="interaction-nullification-future" data-rule-entry data-rule-entry-title="零化 × 未来公共牌"><th scope="row">零化 × 未来公共牌</th><td>零化锁定公共牌位置。该位置的牌值之后即使被天命或千术改变，仍然失效。</td></tr>
              <tr id="interaction-secret-intel" data-rule-entry data-rule-entry-title="绝密 × 情报"><th scope="row">绝密 × 情报</th><td>只阻止对手底牌分支，不阻止未来公共牌分支。</td></tr>
              <tr id="interaction-secret-nullification" data-rule-entry data-rule-entry-title="绝密 × 零化"><th scope="row">绝密 × 零化</th><td>只保护底牌零化，不保护公共牌位置零化。</td></tr>
            </tbody>
          </table>
        </div>
      `,
    },
    {
      id: "rule-match-end",
      number: "17",
      title: "平局、比赛结束与债务终止",
      shortTitle: "比赛结束",
      keywords: "平局 tie split 奇数筹码 大盲 比赛结束 game over 筹码归零 贷款 债务 终止 清空",
      content: `
        <section id="rule-tie" data-rule-entry data-rule-entry-title="平局">
          <h4>平局</h4>
          <p>摊牌时双方最终最佳 5 张完全相同，则判定为平局。双方不获得牌型基础奖励，不产生普通胜利倍率，也不获得普通败者 +1 能量。</p>
          <p>标准争夺筹码平均分配。若底池为奇数，无法平均分配的 1 枚筹码由该手的大盲位获得。</p>
        </section>
        <section id="rule-game-over" data-rule-entry data-rule-entry-title="比赛结束">
          <h4>比赛结束</h4>
          <p>系统先完成当前手的牌局结算与筹码更新，再依据双方真实筹码判断比赛是否结束。任意一方筹码归零时，另一方获得本场比赛胜利。</p>
        </section>
        <section id="rule-debt-expiry" data-rule-entry data-rule-entry-title="贷款债务终止">
          <h4>贷款债务终止</h4>
          <p>若当前手结算后比赛已经结束，未到期贷款、残余筹码债务、残余能量债务与贷款信用状态立即清空，不再进行赛后偿还，也不能通过赛后债务逆转已经成立的胜负。</p>
          <p>若比赛尚未结束，到期偿还按贷款规则执行；偿还可能使付款方筹码归零并结束比赛。</p>
        </section>
      `,
    },
    {
      id: "rule-priority",
      number: "18",
      title: "规则优先级与系统判定",
      shortTitle: "规则优先级",
      keywords: "规则优先级 特殊状态 例外 具体技能 基础规则 标准德州 服务端 权威 合法行动 system ruling",
      content: `
        <p>标准无限注德州扑克规则构成《超限德州》的基础牌局规则；当本游戏的模式、技能或特殊状态明确修改基础规则时，以更具体的规则为准。</p>
        <ol class="rules-priority-stack">
          <li><span>01</span><strong>明确的特殊状态或例外规则</strong></li>
          <li><span>02</span><strong>具体技能规则</strong></li>
          <li><span>03</span><strong>《超限德州》基础规则</strong></li>
          <li><span>04</span><strong>标准无限注德州扑克通用规则</strong></li>
        </ol>
        <p>玩家只能执行当前系统判定为合法的行动或技能。筹码、牌堆、能量、技能状态、行动合法性与最终结算均以服务端权威状态为准。</p>
      `,
    },
  ]),

  skills: Object.freeze([
    {
      id: "skill-deep-breath", number: "01", name: "深呼吸", english: "Deep Breath",
      meta: ["负载 1", "能量 1", "主动 · 公开", "每手 1 次 · 本人下注回合"],
      keywords: "恢复 2 败者 +1 公平 反制",
      content: `<p>只能在自己的合法下注回合发动。支付 1 点能量后，若直到本手结束都没有再发生自己的其他技能事件，则恢复 2 点能量。</p><p>普通弃牌不取消待恢复；若同时属于本手败方，仍可另行获得普通败者 +1 能量。可被反制。公平会清除待恢复状态并抑制该手结束恢复。</p>`,
    },
    {
      id: "skill-recycle", number: "02", name: "回收利用", english: "Recycle",
      meta: ["负载 2", "能量 0", "被动 · 结算公开", "每手最多结算 1 次"],
      keywords: "失败技能 返还 50% 向下取整 反制 绝密",
      content: `<p>手牌结束时检查本人所有“已合法支付费用但最终失败”的技能，从中选择原始费用最高的一次，返还其原始费用的 50% 并向下取整。</p><p>被反制、被绝密阻止，或合法支付后因目标离开合法区域而失败，可以计入。扣费前非法、主动取消、重复请求，以及成功放置但整手未触发的反制，不计入。</p>`,
    },
    {
      id: "skill-intimidation", number: "03", name: "恐吓", english: "Intimidation",
      meta: ["负载 3", "能量 4", "主动 · 公开", "每手 1 次 · 本人下注回合"],
      keywords: "禁止弃牌 500 上限 跟注路径 全下 撤退 绝路",
      content: `<p>仅当双方本手累计标准投入均未超过 500 时可发动。成功后，双方均不能弃牌；每名玩家本手累计标准投入最高为 500；下注与加注必须保留对手合法跟注路径。</p><p>仍可执行全下动作，但标准投入最多增加至累计 500。该上限不限制技能倍率造成的最终额外转移。撤退状态可以存在但不能完成弃牌；绝路仍可发动，但无法通过普通弃牌触发 ×3。</p>`,
    },
    {
      id: "skill-desperation", number: "04", name: "绝境", english: "Desperation",
      meta: ["负载 2", "能量 0", "被动 · 条件满足时公开", "手牌开始判定"],
      keywords: "200 筹码 标准净收益 x3 ×3 恢复1 平局 公平",
      content: `<p>每手开始时，若本人的起始筹码不高于 200，则该手进入绝境。只依据手牌开始快照判定，不会因中途筹码变化动态开启。</p><p>本人获胜时，标准净收益 ×3，并额外恢复 1 点能量；平局不触发。公平可以清除尚未完成的绝境结算并抑制结束恢复。</p>`,
    },
    {
      id: "skill-blood-battle", number: "05", name: "血战", english: "Blood Battle",
      meta: ["负载 2", "能量 3", "主动 · 公开", "每手 1 次 · 本人下注回合"],
      keywords: "输赢翻倍 x2 ×2 双方 x4 ×4 平局 公平",
      content: `<p>成功后，本手最终标准净筹码转移 ×2。双方均发动血战时，两个倍率叠加为 ×4。平局不产生胜者收益。</p><p>最终支付不超过败方实际可支付筹码。公平可以清除仍在持续的血战状态。</p>`,
    },
    {
      id: "skill-defense", number: "06", name: "防守", english: "Defense",
      meta: ["负载 3", "能量 3", "主动 · 秘密", "每手 1 次 · 本人下注回合"],
      keywords: "损失减半 向下取整 弃牌 直接转移",
      content: `<p>成功建立状态后，若本人最终输掉该手，且该手不是以本人弃牌结束，则最终标准净损失取原目标损失的一半并向下取整。</p><p>本人获胜、平局或任何由本人弃牌结束的情况均不产生防守收益；已支付费用不退。直接技能筹码转移不受防守影响。防守实际减少公开损失时，对手可以确认该技能。</p>`,
    },
    {
      id: "skill-perception", number: "07", name: "感知", english: "Perception",
      meta: ["负载 3", "能量 0", "被动 · 完全秘密", "4 个节点 · 每手最多成功 3 次"],
      keywords: "25% 50% 75%真实 25%错误 底牌 翻牌 转牌 河牌 绝密 灵视",
      content: `<p>在底牌发完、翻牌、转牌与河牌四个节点独立判定，每手最多成功 3 次。触发概率随本人筹码劣势从 25% 逐步提高至 50%。</p><p>触发后先选择信息类别，再以 75% 概率提供真实信息、25% 概率提供错误信息；错误信息在当前状态下必须确实为假。同手避免完全相同、等价或直接互相否定的信息。绝密可以阻止受保护底牌信息；灵视只能知道感知事件发生过，不能读取内容与真假。</p>`,
    },
    {
      id: "skill-intel", number: "08", name: "情报", english: "Intel",
      meta: ["负载 3", "能量 4", "主动 · 秘密", "每手 1 次 · 本人下注回合"],
      keywords: "对手底牌 随机 未来公共牌 Flop Turn River 100%真实 绝密",
      content: `<h5>对手底牌</h5><p>系统随机查看对手 1 张底牌，结果 100% 真实，不能指定左牌或右牌。该分支可被绝密阻止。</p><h5>未来公共牌</h5><p>选择任意尚未发出的公共牌位置并查看该位置当前对应的真实牌；翻牌前即可查看未来位置。该分支不受绝密影响。</p><p>分支与目标必须在扣费前确定。一个分支失败后不能临时改选另一个分支。</p>`,
    },
    {
      id: "skill-top-secret", number: "09", name: "绝密", english: "Top Secret",
      meta: ["负载 3", "能量 3", "被动 · 秘密", "每手最多自动启动 1 次"],
      keywords: "底牌保护 读取 推断 交换 零化 情报 千术 感知",
      content: `<p>敌方第一次尝试读取、推断、交换、零化或直接操作本人底牌时，若真实能量不少于 3，则自动支付 3 点并阻止该次效果；成功阻止后，保护持续至本手结束。能量不足时不发动，也不透支。</p><p>可阻止感知中的底牌信息、情报底牌分支、千术交换对手底牌与底牌零化；不阻止未来公共牌情报、灵视或纯技能元信息。第一次真正阻止敌方技能时，对手可以确认绝密存在。</p>`,
    },
    {
      id: "skill-counter", number: "10", name: "反制", english: "Counter",
      meta: ["负载 4", "能量 4", "主动 · 秘密", "每手 1 次 · 仅翻牌前放置"],
      keywords: "陷阱 下一次主动技能 失败 锁技能 空放返1 公平",
      content: `<p>翻牌前在自己的合法行动回合秘密放置。之后捕获对手下一次合法主动技能：对手正常支付费用，该技能失败，并且对手本手不能再发动主动技能或产生新的被动技能事件。</p><p>已完成效果不追溯取消。反制可以捕获对手正在放置的反制；非法请求不会触发。公平不能被反制。若整手未触发，结束时返还 1 点能量，空放净成本为 3。</p>`,
    },
    {
      id: "skill-fairness", number: "11", name: "公平", english: "Fairness",
      meta: ["负载 4", "能量 3", "主动 · 公开", "每手 1 次 · 本人下注回合"],
      keywords: "不能被反制 清除状态 封锁技能 抑制恢复 既定事实 贷款信用",
      content: `<p>公平不能被反制。成功后清除双方仍存在的持续、预埋与待结算状态，包括反制陷阱、防守、血战、恐吓、绝密保护、绝境待结算、深呼吸待恢复、零化、撤退、未触发试探、伪装，以及尚未偿还的贷款状态与残余债务。</p><p>本手之后不能产生新的主动或被动技能事件，手牌结束时的全部能量恢复也被抑制。已经获得的信息、已经完成的换牌或牌堆修改、已完成的直接筹码转移与终局没收不回滚。若实际清除金额大于 0 的贷款债务，信用只能进入或保持受限，不能直接恢复正常。</p>`,
    },
    {
      id: "skill-cheat", number: "12", name: "千术", english: "Cheat",
      meta: ["负载 5", "能量 6", "主动 · 可见性混合", "每手 1 次 · 本人下注回合"],
      keywords: "交换 自己底牌 对手底牌 公共牌 未来牌 下一张 牌堆 随机 52张唯一",
      content: `<p>选择自己 1 张底牌，与以下目标之一交换：对手指定位置的底牌、已公开公共牌、尚未发出的公共牌位置、下一张有效发牌，或剩余牌堆中随机 1 张非顶部且排除下一张有效发牌的牌。</p><p>交换对手底牌时可指定位置但不能预知牌值，并受绝密保护；交换已公开公共牌会自然公开牌面变化；未来位置与牌堆交换的具体结果保持秘密。所有交换必须维持 52 张牌唯一，已完成交换不被公平回滚。</p>`,
    },
    {
      id: "skill-dead-end", number: "13", name: "绝路", english: "Dead End",
      meta: ["负载 4", "能量 5", "主动 · 公开", "每手 1 次 · 本人下注回合"],
      keywords: "最大合法全下 ALL IN 锁技能 普通弃牌 x3 ×3 摊牌 恐吓 伪装",
      content: `<p>成功后执行当前规则允许的最大合法全下，并封锁对手本手之后新的主动与被动技能事件；已经存在的技能状态不会自动清除。</p><p>若对手随后普通弃牌，绝路发动者标准净收益 ×3；若对手跟注并进入摊牌，绝路本身不提供 ×3。恐吓状态下仍可发动，但投入受 500 上限限制。绝路全下始终向双方公开，即使存在伪装。</p>`,
    },
    {
      id: "skill-clairvoyance", number: "14", name: "灵视", english: "Clairvoyance",
      meta: ["负载 3", "能量 2", "主动 · 秘密", "每手 1 次 · 本人下注回合"],
      keywords: "真实能量 已发生技能事件 负能量 天命 伪装 绝密 反制",
      content: `<p>私下获得对手真实当前能量，以及本手截至当前已经发生的技能事件。可以读取负能量，也可以读取天命持有者的 9 或 10 点真实能量。</p><p>不会提供感知内容与真假、情报目标、隐藏换牌细节、天命点名、强运私人结果、贷款能量细节、重启新牌或尚未触发的完整构筑。不能穿透伪装读取筹码、底池与下注数字。不受绝密阻挡，可被反制。</p>`,
    },
    {
      id: "skill-nullification", number: "15", name: "零化", english: "Nullification",
      meta: ["负载 5", "公共牌 6 / 底牌 7", "主动 · 完全秘密", "每手 1 次 · 翻牌及之后"],
      keywords: "未来公共牌位置 已公开 公共牌不存在 随机底牌 最佳五张 绝密 公平",
      content: `<h5>公共牌零化 · 费用 6</h5><p>精确指定一个已经公开或尚未发出的公共牌位置。该位置在最终牌型评估时对双方均视为不存在。零化锁定公共牌位置；该位置之后即使被其他技能改变牌值，仍保持失效。双方可零化同一位置，两次均正常扣费，该位置只失效一次。</p><h5>底牌零化 · 费用 7</h5><p>系统随机选择对手 1 张底牌，使其不参与对手最终最佳 5 张牌评估。该分支可被绝密阻止。</p><p>零化属于持续状态，可被公平清除；发动、分支与目标在结算前保持秘密，最终结算时按规则揭露。</p>`,
    },
    {
      id: "skill-fortune", number: "16", name: "强运", english: "Fortune",
      meta: ["负载 5", "牌面改良 3", "被动 · 完全秘密", "底牌 / 翻牌 / 转牌 / 河牌 / 结束资源"],
      keywords: "自动改牌 资源 +1 能量 最低-4 负能量 公共牌 不读对手底牌",
      content: `<p>在底牌、翻牌、转牌、河牌与手牌结束资源阶段自动判定。牌面改良成功时支付 3 点能量；资源型强运成功时额外获得 1 点能量，不支付改牌费用，也不会递归触发强运。</p><p>强底牌不会被强制改动；较差时可自动尝试改善。玩家不能选择是否触发、换哪张或换成哪张。公共牌判定不得读取对手底牌。强运允许真实能量最低降至 -4；若继续支付会低于 -4，则该次改牌不发生。负能量期间只有强运可以产生新的技能事件。</p>`,
    },
    {
      id: "skill-destiny", number: "17", name: "天命", english: "Destiny",
      meta: ["负载 5", "能量 7", "主动 · 完全秘密", "转牌后 · 本人下注回合 · 无固定次数上限"],
      keywords: "点名 精确牌 河牌 River 牌堆 上限10 初始4 反制 公平",
      content: `<p>只能在转牌已经公开后、自己的合法下注回合发动。选择 1 张仍处于合法可操作牌堆中的具体牌，使其立即成为下一张真正发出的河牌。</p><p>牌堆修改在技能成功时立即完成，属于既定事实，不被公平回滚。目标不合法时费用照付且失败；反制可以完全阻止。装备天命后真实能量上限由 8 提高至 10，初始能量仍为 4。天命不设固定每手次数上限，但每次都受阶段、行动窗口与能量限制。</p>`,
    },
    {
      id: "skill-loan", number: "18", name: "贷款", english: "Loan",
      meta: ["负载 2", "能量 2", "主动 · 可见性混合", "本人下注回合 · 次数由信用决定"],
      keywords: "筹码贷款 100 150 能量贷款 +5 偿还6 正常信用 信用受限 违约 公平 反制",
      content: `<p>发动前选择筹码贷款或能量贷款。正常信用时，筹码贷款每手最多 2 次，能量贷款每手最多 1 次，合计最多 3 次；信用受限时两种分支合计每手只能发动 1 次；违约时整项贷款不可发动。</p><h5>筹码贷款 · 公开</h5><p>支付 2 点能量，从对手处直接取得 100 筹码；对手不足 100 时取得其全部剩余筹码。下一手结束偿还 150；两笔贷款分别到期。无法全额偿还时，支付现有筹码，剩余形成筹码债务。取得或偿还都可能使一方筹码归零并结束比赛。</p><h5>能量贷款 · 秘密</h5><p>支付 2 点能量后立即获得 5 点能量，不超过个人上限。下一手结束偿还 6；不足时先扣现有能量，剩余形成能量债务，之后获得的能量优先还债。</p><h5>信用</h5><p>到期无法全额真实偿还并形成残余债务时进入违约。信用受限后，只有一笔在受限状态下新产生、正常到期、完全由真实资源偿还且没有任何部分被免除的贷款，才能恢复正常。违约残债被真实全部偿还时恢复正常；若由公平清除，只恢复为信用受限。</p><p>公平可清除未偿状态但不退回已取得资源；实际清债会使信用进入或保持受限。反制命中时费用照付，但不获得资源、不产生债务，也不改变信用。比赛依法结束后，全部贷款状态与信用清空。伪装生效时，筹码贷款只公开发动行为，不公开具体数字。</p>`,
    },
    {
      id: "skill-alert", number: "19", name: "警觉", english: "Alert",
      meta: ["负载 1", "能量 0", "被动 · 完全秘密", "每手最多成功提示 1 次"],
      keywords: "秘密主动技能 10 25 40 55 70 85 100 敏锐度 下一次行动 伪装",
      content: `<p>只监听对手合法、正式提交且仍对本人隐藏的主动技能事件。公开主动、被动、非法请求、取消与重复请求不触发。</p><p>检测率依次为 10% → 25% → 40% → 55% → 70% → 85% → 100%。每次漏过提高一级，成功后重置为 10%，敏锐度跨手保留。成功信息在本人下一次合法下注决策开始时统一提示，不透露技能名称、类型、费用、结果、数量或精确时间。伪装属于公开主动技能，不触发警觉。</p>`,
    },
    {
      id: "skill-retreat", number: "20", name: "撤退", english: "Retreat",
      meta: ["负载 2", "能量 3", "主动 · 秘密", "每手 1 次 · 本人下注回合"],
      keywords: "同一窗口 立即弃牌 Fold 退还贡献 标准净0 败者不回能量 恐吓 试探 绝路",
      content: `<p>在自己的合法下注窗口建立撤退状态。可在同一行动窗口立即弃牌，也可在之后的其他合法弃牌窗口使用。</p><p>撤退弃牌时，该手立即结束，双方本手全部标准下注贡献原路退还，标准净筹码转移为 0，使用者不获得普通败者 +1 能量。不会回滚贷款或终局直接转移、已支付能量、已获信息、换牌或牌堆修改。</p><p>状态未用于弃牌时按正常结果结算。被反制时费用已付、状态不建立，玩家留在原行动窗口。公平可清除状态；恐吓下不能完成弃牌；撤退弃牌不触发试探。</p>`,
    },
    {
      id: "skill-restart", number: "21", name: "重启", english: "Restart",
      meta: ["负载 4", "能量 3", "主动 · 秘密", "每手 1 次 · 本人下注回合"],
      keywords: "两张底牌 洗回牌堆 随机重抽 可抽回原牌 52张唯一 公平",
      content: `<p>将本人的两张底牌一并洗回合法剩余牌堆，然后随机重新抽取 2 张底牌。翻牌前至河牌均可在自己的合法下注回合发动。</p><p>允许重新抽回原来的牌。完成后的换牌属于既定事实，不被公平回滚；整个过程必须维持 52 张牌唯一。</p>`,
    },
    {
      id: "skill-probe", number: "22", name: "试探", english: "Probe",
      meta: ["负载 1", "能量 2", "主动 · 秘密", "每手 1 次 · 本人下注回合"],
      keywords: "对手普通弃牌 基础收益 +50 倍率 撤退 公平",
      content: `<p>若对手在发动后主动选择普通弃牌，本手标准结算基础值额外 +50，再参与后续合法倍率。</p><div class="rules-formula"><code>(基础标准净收益 100 + 试探 50) × 血战 2 = 300</code></div><p>自己弃牌不触发自己的试探；对手撤退弃牌也不触发。未触发状态可被公平清除。</p>`,
    },
    {
      id: "skill-disguise", number: "23", name: "伪装", english: "Disguise",
      meta: ["负载 4", "能量 2", "主动 · 公开", "每手 1 次 · 本人下注回合"],
      keywords: "隐藏筹码 底池 下注 跟注 加注 最小加注 全下 超额输入 灵视 警觉 公平",
      content: `<p>成功后，对受影响的对手隐藏双方剩余筹码、筹码变化、本手累计投入、底池、下注 / 跟注 / 加注金额、最小加注、需补跟注及其他可反推真实筹码的数字。</p><p>受影响玩家仍可执行系统提供的合法操作。超额输入按真实最大合法投入处理，不返回可反推余额的数字。普通全下对对手不显示全下标签或专属表现，但玩家本人始终知道自己是否全下；绝路全下强制公开。</p><p>双方均发动时，各自看不到对手相关筹码数值，但仍知道本人全下状态。灵视不能穿透伪装读取筹码信息；伪装为公开技能，不触发警觉。公平清除后只恢复未来显示，不补填历史数值。</p>`,
    },
    {
      id: "skill-endgame", number: "24", name: "终局", english: "Endgame",
      meta: ["负载 6", "能量 8", "主动 · 公开", "每手 1 次 · 合法下注或专属响应窗口"],
      keywords: "全下 跟注后筹码归零 未匹配 没收 锁池 处决 同牌型 皇家同花顺 反制 倍率",
      content: `<p>可在自己的合法下注窗口发动，包括面对下注、加注或普通全下。对手合法跟注后真实剩余筹码归零，且下一张公共牌尚未发出、摊牌尚未执行时，可产生只属于刚刚造成该跟注归零的进攻方的专属响应窗口；玩家可发动或放弃，超时视为放弃。</p><h5>成功顺序</h5><ol class="rules-steps"><li>验证合法性并支付 8 点能量；</li><li>处理反制；命中则技能失败，不没收、不锁池、不关闭下注、不进入处决；</li><li>成功公开后计算双方标准贡献，锁定可匹配部分；</li><li>只将对手多出的未匹配标准投入直接没收给发动者；</li><li>关闭后续下注、跟注、加注与弃牌，记录处决资格；</li><li>按当前真实牌堆发完公共牌并摊牌。</li></ol><p>发动者本人多出的未匹配投入仍按普通规则退还。终局没收属于直接技能筹码转移，不参与血战、绝境或协议倍率。</p><h5>处决</h5><p>只有对手在终局发动前已经因真实标准全下，或合法跟注后真实剩余筹码归零，才具有处决资格。恐吓下只记录了全下动作但仍有剩余筹码时，不构成处决。</p><p>没有处决资格时正常比牌。有处决资格时，双方牌型等级不同仍正常比较；等级完全相同时，发动者直接获胜，不再比较同类牌型内部点数或踢脚。皇家同花顺与普通同花顺属于不同等级。</p>`,
    },
  ]),

  protocols: Object.freeze([
    { id: "protocol-high-card", name: "协议--高牌", english: "High Card Protocol", hand: "高牌" },
    { id: "protocol-pair", name: "协议--对子", english: "One Pair Protocol", hand: "一对" },
    { id: "protocol-two-pair", name: "协议--两对", english: "Two Pair Protocol", hand: "两对" },
    { id: "protocol-trips", name: "协议--三条", english: "Three of a Kind Protocol", hand: "三条" },
    { id: "protocol-straight", name: "协议--顺子", english: "Straight Protocol", hand: "顺子" },
    { id: "protocol-flush", name: "协议--同花", english: "Flush Protocol", hand: "同花" },
    { id: "protocol-full-house", name: "协议--葫芦", english: "Full House Protocol", hand: "葫芦" },
    { id: "protocol-quads", name: "协议--四条", english: "Four of a Kind Protocol", hand: "四条" },
    { id: "protocol-straight-flush", name: "协议--同花顺", english: "Straight Flush Protocol", hand: "同花顺、皇家同花顺" },
  ]),
});

if (typeof window !== "undefined") window.OVERLIMIT_RULEBOOK_V1 = OVERLIMIT_RULEBOOK_V1;
if (typeof module !== "undefined" && module.exports) module.exports = OVERLIMIT_RULEBOOK_V1;
