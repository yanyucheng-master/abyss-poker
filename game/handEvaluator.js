function compareRankVectors(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function getStraightHigh(values) {
  const unique = [...new Set(values)].sort((x, y) => y - x);
  if (unique.includes(14)) unique.push(1);
  let run = 1;
  let high = null;
  for (let i = 1; i < unique.length; i += 1) {
    if (unique[i - 1] - unique[i] === 1) {
      run += 1;
      if (run >= 5) high = unique[i - 4];
    } else {
      run = 1;
    }
  }
  return high;
}

function evaluateFive(cards) {
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const values = sorted.map((c) => c.value);
  const flush = sorted.every((c) => c.suit === sorted[0].suit);
  const straightHigh = getStraightHigh(values);

  const counts = new Map();
  values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });

  if (flush && straightHigh === 14 && values.includes(10)) {
    return { category: 10, handName: "皇家同花顺", rankVector: [14], bestFive: sorted };
  }
  if (flush && straightHigh) {
    return { category: 9, handName: "同花顺", rankVector: [straightHigh], bestFive: sorted };
  }
  if (groups[0][1] === 4) {
    return {
      category: 8,
      handName: "四条",
      rankVector: [groups[0][0], groups[1][0]],
      bestFive: sorted,
    };
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return {
      category: 7,
      handName: "葫芦",
      rankVector: [groups[0][0], groups[1][0]],
      bestFive: sorted,
    };
  }
  if (flush) {
    return { category: 6, handName: "同花", rankVector: values, bestFive: sorted };
  }
  if (straightHigh) {
    return { category: 5, handName: "顺子", rankVector: [straightHigh], bestFive: sorted };
  }
  if (groups[0][1] === 3) {
    const kickers = groups.slice(1).map((x) => x[0]).sort((a, b) => b - a);
    return {
      category: 4,
      handName: "三条",
      rankVector: [groups[0][0], ...kickers],
      bestFive: sorted,
    };
  }
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const highPair = Math.max(groups[0][0], groups[1][0]);
    const lowPair = Math.min(groups[0][0], groups[1][0]);
    return {
      category: 3,
      handName: "两对",
      rankVector: [highPair, lowPair, groups[2][0]],
      bestFive: sorted,
    };
  }
  if (groups[0][1] === 2) {
    const kickers = groups.slice(1).map((x) => x[0]).sort((a, b) => b - a);
    return {
      category: 2,
      handName: "一对",
      rankVector: [groups[0][0], ...kickers],
      bestFive: sorted,
    };
  }
  return { category: 1, handName: "高牌", rankVector: values, bestFive: sorted };
}

function pickBestFive(cards7) {
  const combos = [];
  for (let a = 0; a < cards7.length - 4; a += 1) {
    for (let b = a + 1; b < cards7.length - 3; b += 1) {
      for (let c = b + 1; c < cards7.length - 2; c += 1) {
        for (let d = c + 1; d < cards7.length - 1; d += 1) {
          for (let e = d + 1; e < cards7.length; e += 1) {
            combos.push([cards7[a], cards7[b], cards7[c], cards7[d], cards7[e]]);
          }
        }
      }
    }
  }

  let best = null;
  for (const combo of combos) {
    const score = evaluateFive(combo);
    if (!best) {
      best = score;
      continue;
    }
    if (score.category > best.category) {
      best = score;
      continue;
    }
    if (score.category === best.category && compareRankVectors(score.rankVector, best.rankVector) > 0) {
      best = score;
    }
  }
  return best;
}

function compareEvaluatedHands(a, b) {
  if (a.category !== b.category) return a.category > b.category ? 1 : -1;
  return compareRankVectors(a.rankVector, b.rankVector);
}

module.exports = {
  pickBestFive,
  compareEvaluatedHands,
  compareRankVectors,
};
