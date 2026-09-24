// VERBATIM copy of nestCuts from patio-tool index.html lines 25236-25343,
// commit 884a208 (2026-08-10). Test fixture only: the parity test proves
// cut_to_order.ts reproduces it. Never import this outside tests.
// deno-lint-ignore-file
export
function nestCuts(cutLengthMm, qty, stockLengths, opts) {
    const SAW_KERF = 3; // 3mm saw cut allowance
    const sorted = [...stockLengths].sort((a, b) => a - b);
    const maxStock = sorted[sorted.length - 1];

    // Check for special order (single piece too long for any stock)
    if (cutLengthMm > maxStock) {
        return {
            sticks: [],
            totalSticks: qty,
            totalWaste: 0,
            specialOrder: true,
            cutLength: cutLengthMm,
            piecesPerStick: 1,
            orderSummary: qty + '× SPECIAL ORDER (>' + (maxStock / 1000).toFixed(1) + 'm)'
        };
    }

    // Pick the smallest stock that fits at least one piece
    var bestStock = maxStock;
    for (var si = 0; si < sorted.length; si++) {
        if (sorted[si] >= cutLengthMm) {
            bestStock = sorted[si];
            break;
        }
    }

    // One-per-stick mode: each piece gets its own smallest stock (e.g. posts)
    if (opts && opts.onePerStick) {
        var sticks = [];
        for (var i = 0; i < qty; i++) {
            sticks.push({ stockLength: bestStock, cuts: [cutLengthMm], waste: bestStock - cutLengthMm });
        }
        var totalWaste = sticks.reduce(function(s, st) { return s + st.waste; }, 0);
        return {
            sticks: sticks,
            totalSticks: qty,
            totalWaste: totalWaste,
            specialOrder: false,
            cutLength: cutLengthMm,
            piecesPerStick: 1,
            stockLength: bestStock,
            orderSummary: qty + '× ' + (bestStock / 1000).toFixed(1) + 'm sticks'
        };
    }

    // How many pieces fit in one stick?
    var piecesPerStick = 0;
    var testLen = 0;
    while (testLen + cutLengthMm <= bestStock) {
        piecesPerStick++;
        testLen += cutLengthMm + SAW_KERF;
    }
    if (piecesPerStick < 1) piecesPerStick = 1;

    // Could we fit more pieces using a longer stock?
    for (var li = sorted.indexOf(bestStock) + 1; li < sorted.length; li++) {
        var bigStock = sorted[li];
        var bigPieces = 0;
        var tl = 0;
        while (tl + cutLengthMm <= bigStock) {
            bigPieces++;
            tl += cutLengthMm + SAW_KERF;
        }
        // Only use longer stock if it reduces total sticks needed
        var sticksSmall = Math.ceil(qty / piecesPerStick);
        var sticksBig = Math.ceil(qty / bigPieces);
        if (sticksBig < sticksSmall) {
            bestStock = bigStock;
            piecesPerStick = bigPieces;
        }
    }

    var totalSticks = Math.ceil(qty / piecesPerStick);
    var sticks = [];
    var remaining = qty;
    for (var i = 0; i < totalSticks; i++) {
        var n = Math.min(remaining, piecesPerStick);
        var used = n * cutLengthMm + (n - 1) * SAW_KERF;
        var waste = bestStock - used;
        var cuts = [];
        for (var j = 0; j < n; j++) cuts.push(cutLengthMm);
        sticks.push({ stockLength: bestStock, cuts: cuts, waste: waste });
        remaining -= n;
    }

    var totalWaste = sticks.reduce(function(s, st) { return s + st.waste; }, 0);
    var stockLabel = (bestStock / 1000).toFixed(1) + 'm';
    var orderSummary = totalSticks + '× ' + stockLabel + ' sticks';
    if (piecesPerStick > 1) {
        orderSummary += ' (' + piecesPerStick + ' pcs/stick';
        if (sticks.length > 0 && sticks[sticks.length - 1].cuts.length < piecesPerStick) {
            orderSummary += ', last stick ' + sticks[sticks.length - 1].cuts.length + ' pcs';
        }
        orderSummary += ')';
    }

    return {
        sticks: sticks,
        totalSticks: totalSticks,
        totalWaste: totalWaste,
        specialOrder: false,
        cutLength: cutLengthMm,
        piecesPerStick: piecesPerStick,
        stockLength: bestStock,
        orderSummary: orderSummary
    };
}
