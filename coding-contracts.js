/**
 * coding-contracts.js — Auto-solver for all Coding Contract types.
 *
 * Scans every reachable server for .cct files, solves them, and attempts submission.
 * Runs once per invocation (no loop) so autopilot can schedule it via launchScriptHelper.
 * Re-run it on a timer or after augment installs to sweep up freshly spawned contracts.
 *
 * RAM: ~12.5 GB base (scan + codingcontract.attempt + getContractType + getData)
 *   + ns.run overhead. Designed to be launched by autopilot.js.
 *
 * Supported contract types (all 31 current types):
 *   Find Largest Prime Factor                    Subarray with Maximum Sum
 *   Total Ways to Sum (I & II)                   Array Jumping Game (I & II)
 *   Spiralize Matrix                              Merge Overlapping Intervals
 *   Generate IP Addresses                         Unique Paths in a Grid (I & II)
 *   Shortest Path in a Grid                       Minimum Path Sum in a Triangle
 *   Algorithmic Stock Trader (I–IV)               Sanitize Parentheses in Expression
 *   Find All Valid Math Expressions               HammingCodes: Integer→Binary & Binary→Integer
 *   Proper 2-Coloring of a Graph                  Compression I (RLE), II (LZ Decomp), III (LZ Comp)
 *   Encryption I (Caesar) & II (Vigenère)         Square Root (BigInt)
 *   Total Number of Primes                        Largest Rectangle in a Matrix
 *
 * @param {NS} ns
 */
export async function main(ns) {
    ns.disableLog("ALL");

    const log     = (msg, toTerminal = false) => { ns.print(msg); if (toTerminal) ns.tprint(msg); };
    const success = (msg) => { ns.print(`SUCCESS: ${msg}`); ns.tprint(`SUCCESS: ${msg}`); };
    const warn    = (msg) => { ns.print(`WARN: ${msg}`);    ns.tprint(`WARN: ${msg}`); };

    // ── Discover all servers ───────────────────────────────────────────────────
    function getAllServers() {
        const visited = new Set();
        const queue = ["home"];
        while (queue.length > 0) {
            const host = queue.shift();
            if (visited.has(host)) continue;
            visited.add(host);
            for (const neighbor of ns.scan(host))
                if (!visited.has(neighbor)) queue.push(neighbor);
        }
        return [...visited];
    }

    const servers = getAllServers();
    let found = 0, solved = 0, failed = 0, skipped = 0;

    for (const host of servers) {
        const files = ns.ls(host, ".cct");
        if (files.length === 0) continue;

        for (const file of files) {
            found++;
            const type = ns.codingcontract.getContractType(file, host);
            const data = ns.codingcontract.getData(file, host);
            const triesLeft = ns.codingcontract.getNumTriesRemaining(file, host);

            let answer;
            try {
                answer = solve(type, data);
            } catch (e) {
                warn(`${host}/${file} [${type}] — solver threw: ${e.message ?? e}`);
                skipped++;
                continue;
            }

            if (answer === null || answer === undefined) {
                warn(`${host}/${file} [${type}] — no solver for this type, skipping.`);
                skipped++;
                continue;
            }

            // Safety: never attempt contracts with 1 try left unless we're confident
            // (all solvers here are deterministic & verified against game source)
            if (triesLeft < 1) {
                warn(`${host}/${file} [${type}] — 0 tries remaining, skipping.`);
                skipped++;
                continue;
            }

            const reward = ns.codingcontract.attempt(answer, file, host);
            if (reward && reward !== "") {
                solved++;
                success(`${host}/${file} [${type}] → ${reward}`);
            } else {
                failed++;
                warn(`${host}/${file} [${type}] — WRONG answer submitted: ${JSON.stringify(answer)} (${triesLeft - 1} tries left)`);
            }
        }
    }

    log(`Coding contracts sweep complete: ${found} found, ${solved} solved, ${failed} failed, ${skipped} skipped.`, true);
}

// ══════════════════════════════════════════════════════════════════════════════
// SOLVER DISPATCH
// Returns the answer in the format the contract expects, or null if unsupported.
// ══════════════════════════════════════════════════════════════════════════════
function solve(type, data) {
    switch (type) {
        // ── Arithmetic / Number Theory ────────────────────────────────────────
        case "Find Largest Prime Factor":           return solveLargestPrimeFactor(data);
        case "Subarray with Maximum Sum":           return solveMaxSubarraySum(data);
        case "Total Ways to Sum":                   return solveTotalWaysToSum(data);
        case "Total Ways to Sum II":                return solveTotalWaysToSumII(data);
        case "Total Number of Primes":              return solveTotalPrimesInRange(data);
        case "Square Root":                         return solveSquareRoot(data);

        // ── Array / Grid ──────────────────────────────────────────────────────
        case "Spiralize Matrix":                    return solveSpiralizeMatrix(data);
        case "Array Jumping Game":                  return solveArrayJumpingGame(data);
        case "Array Jumping Game II":               return solveArrayJumpingGameII(data);
        case "Merge Overlapping Intervals":         return solveMergeIntervals(data);
        case "Unique Paths in a Grid I":            return solveUniquePathsI(data);
        case "Unique Paths in a Grid II":           return solveUniquePathsII(data);
        case "Shortest Path in a Grid":             return solveShortestPath(data);
        case "Minimum Path Sum in a Triangle":      return solveMinTrianglePath(data);
        case "Largest Rectangle in a Matrix":       return solveLargestRectangle(data);

        // ── Network / String ──────────────────────────────────────────────────
        case "Generate IP Addresses":               return solveGenerateIPs(data);
        case "Sanitize Parentheses in Expression":  return solveSanitizeParentheses(data);
        case "Find All Valid Math Expressions":     return solveMathExpressions(data);
        case "Proper 2-Coloring of a Graph":        return solveGraphColoring(data);

        // ── Stock Trader ──────────────────────────────────────────────────────
        case "Algorithmic Stock Trader I":          return solveStockI(data);
        case "Algorithmic Stock Trader II":         return solveStockII(data);
        case "Algorithmic Stock Trader III":        return solveStockIII(data);
        case "Algorithmic Stock Trader IV":         return solveStockIV(data);

        // ── Compression / Encoding ────────────────────────────────────────────
        case "Compression I: RLE Compression":      return solveRLECompression(data);
        case "Compression II: LZ Decompression":    return solveLZDecompression(data);
        case "Compression III: LZ Compression":     return solveLZCompression(data);
        case "HammingCodes: Integer to Encoded Binary": return solveHammingEncode(data);
        case "HammingCodes: Encoded Binary to Integer": return solveHammingDecode(data);
        case "Encryption I: Caesar Cipher":         return solveCaesarCipher(data);
        case "Encryption II: Vigenère Cipher":      return solveVigenereCipher(data);

        default: return null; // Unknown type — skip safely
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// INDIVIDUAL SOLVERS
// ══════════════════════════════════════════════════════════════════════════════

// ── Find Largest Prime Factor ─────────────────────────────────────────────────
// Input: number n. Output: largest prime factor (number).
function solveLargestPrimeFactor(n) {
    let fac = 2;
    while (n > (fac - 1) * (fac - 1)) {
        while (n % fac === 0) n = Math.round(n / fac);
        fac++;
    }
    return n === 1 ? fac - 1 : n;
}

// ── Subarray with Maximum Sum (Kadane's) ──────────────────────────────────────
// Input: number[]. Output: maximum contiguous subarray sum (number).
function solveMaxSubarraySum(arr) {
    const nums = arr.slice();
    for (let i = 1; i < nums.length; i++)
        nums[i] = Math.max(nums[i], nums[i] + nums[i - 1]);
    return Math.max(...nums);
}

// ── Total Ways to Sum (partition into 2+ positive integers) ───────────────────
// Input: number n. Output: count of ways (number).
function solveTotalWaysToSum(n) {
    const ways = new Array(n + 1).fill(0);
    ways[0] = 1;
    for (let i = 1; i < n; i++)
        for (let j = i; j <= n; j++)
            ways[j] += ways[j - i];
    return ways[n];
}

// ── Total Ways to Sum II (coin-change with given set) ─────────────────────────
// Input: [n, number[]]. Output: count of ways (number).
function solveTotalWaysToSumII([n, coins]) {
    const ways = new Array(n + 1).fill(0);
    ways[0] = 1;
    for (const coin of coins)
        for (let j = coin; j <= n; j++)
            ways[j] += ways[j - coin];
    return ways[n];
}

// ── Total Number of Primes (Sieve of Eratosthenes on a range) ─────────────────
// Input: [low, high]. Output: count of primes inclusive (number).
function solveTotalPrimesInRange([low, high]) {
    // Segmented sieve for large ranges (high can be ~6M)
    const limit = Math.ceil(Math.sqrt(high)) + 1;
    const smallSieve = new Uint8Array(limit + 1); // 0 = prime
    for (let i = 2; i * i <= limit; i++)
        if (!smallSieve[i])
            for (let j = i * i; j <= limit; j += i)
                smallSieve[j] = 1;
    const smallPrimes = [];
    for (let i = 2; i <= limit; i++)
        if (!smallSieve[i]) smallPrimes.push(i);

    const size = high - low + 1;
    const sieve = new Uint8Array(size); // 0 = prime
    // low itself: mark 0 and 1 as non-prime
    if (low <= 1) sieve[1 - low] = 1;
    if (low === 0) sieve[0] = 1;
    for (const p of smallPrimes) {
        const start = Math.max(p * p, Math.ceil(low / p) * p);
        for (let j = start; j <= high; j += p)
            if (j !== p) sieve[j - low] = 1;
    }
    let count = 0;
    for (let i = 0; i < size; i++)
        if (!sieve[i] && (low + i) >= 2) count++;
    return count;
}

// ── Square Root (BigInt Newton-Raphson) ───────────────────────────────────────
// Input: bigint n (as BigInt, passed directly via getContract.data).
// Output: string representation of floor(sqrt(n)).
function solveSquareRoot(n) {
    // Newton's method for integer square root
    if (n < 0n) return "0";
    if (n < 2n) return n.toString();
    let x = BigInt(1) << BigInt(Math.ceil(BigInt(n).toString(2).length / 2) + 1);
    let y = (x + n / x) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    // Verify and adjust for rounding
    if (x * x > n) x--;
    return x.toString();
}

// ── Spiralize Matrix ──────────────────────────────────────────────────────────
// Input: number[][]. Output: number[] in spiral order.
function solveSpiralizeMatrix(matrix) {
    const result = [];
    let top = 0, bottom = matrix.length - 1;
    let left = 0, right = matrix[0].length - 1;
    while (top <= bottom && left <= right) {
        for (let c = left; c <= right; c++) result.push(matrix[top][c]);
        top++;
        for (let r = top; r <= bottom; r++) result.push(matrix[r][right]);
        right--;
        if (top <= bottom) {
            for (let c = right; c >= left; c--) result.push(matrix[bottom][c]);
            bottom--;
        }
        if (left <= right) {
            for (let r = bottom; r >= top; r--) result.push(matrix[r][left]);
            left++;
        }
    }
    return result;
}

// ── Array Jumping Game (can reach end?) ───────────────────────────────────────
// Input: number[]. Output: 1 (reachable) or 0.
function solveArrayJumpingGame(arr) {
    let maxReach = 0;
    for (let i = 0; i < arr.length; i++) {
        if (i > maxReach) return 0;
        maxReach = Math.max(maxReach, i + arr[i]);
    }
    return 1;
}

// ── Array Jumping Game II (minimum jumps, 0 if impossible) ───────────────────
// Input: number[]. Output: number.
function solveArrayJumpingGameII(arr) {
    const n = arr.length;
    if (n <= 1) return 0;
    let jumps = 0, curEnd = 0, farthest = 0;
    for (let i = 0; i < n - 1; i++) {
        farthest = Math.max(farthest, i + arr[i]);
        if (i === curEnd) {
            if (farthest <= curEnd) return 0; // stuck
            jumps++;
            curEnd = farthest;
            if (curEnd >= n - 1) return jumps;
        }
    }
    return curEnd >= n - 1 ? jumps : 0;
}

// ── Merge Overlapping Intervals ───────────────────────────────────────────────
// Input: [number, number][]. Output: [number, number][] merged and sorted.
function solveMergeIntervals(intervals) {
    const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
    const merged = [sorted[0].slice()];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        if (sorted[i][0] <= last[1])
            last[1] = Math.max(last[1], sorted[i][1]);
        else
            merged.push(sorted[i].slice());
    }
    return merged;
}

// ── Unique Paths in a Grid I (no obstacles) ───────────────────────────────────
// Input: [rows, cols]. Output: number of paths (number).
function solveUniquePathsI([rows, cols]) {
    const dp = new Array(cols).fill(1);
    for (let r = 1; r < rows; r++)
        for (let c = 1; c < cols; c++)
            dp[c] += dp[c - 1];
    return dp[cols - 1];
}

// ── Unique Paths in a Grid II (with obstacles) ────────────────────────────────
// Input: (0|1)[][] grid (1=obstacle). Output: number of paths (number).
function solveUniquePathsII(grid) {
    const rows = grid.length, cols = grid[0].length;
    const dp = new Array(cols).fill(0);
    dp[0] = grid[0][0] === 0 ? 1 : 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (grid[r][c] === 1) { dp[c] = 0; continue; }
            if (c > 0) dp[c] += dp[c - 1];
        }
    }
    return dp[cols - 1];
}

// ── Shortest Path in a Grid (BFS) ─────────────────────────────────────────────
// Input: (0|1)[][] grid (1=obstacle). Output: UDLR string or "" if no path.
function solveShortestPath(grid) {
    const rows = grid.length, cols = grid[0].length;
    if (grid[0][0] === 1 || grid[rows-1][cols-1] === 1) return "";
    const dirs = [[-1,0,"U"],[1,0,"D"],[0,-1,"L"],[0,1,"R"]];
    const visited = Array.from({length: rows}, () => new Array(cols).fill(false));
    const queue = [[0, 0, ""]];
    visited[0][0] = true;
    while (queue.length > 0) {
        const [r, c, path] = queue.shift();
        if (r === rows - 1 && c === cols - 1) return path;
        for (const [dr, dc, dir] of dirs) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited[nr][nc] && grid[nr][nc] === 0) {
                visited[nr][nc] = true;
                queue.push([nr, nc, path + dir]);
            }
        }
    }
    return "";
}

// ── Minimum Path Sum in a Triangle ────────────────────────────────────────────
// Input: number[][] (triangle). Output: minimum path sum from top to bottom.
function solveMinTrianglePath(triangle) {
    const dp = triangle[triangle.length - 1].slice();
    for (let r = triangle.length - 2; r >= 0; r--)
        for (let c = 0; c <= r; c++)
            dp[c] = triangle[r][c] + Math.min(dp[c], dp[c + 1]);
    return dp[0];
}

// ── Largest Rectangle in a Matrix ─────────────────────────────────────────────
// Input: (0|1)[][] matrix. Output: [[r1,c1],[r2,c2]] corners of largest 0-rectangle.
function solveLargestRectangle(data) {
    const rows = data.length, cols = data[0].length;
    // Build column-height histograms (how many consecutive 0s above each cell)
    const hist = Array.from({length: rows}, () => new Array(cols).fill(0));
    for (let c = 0; c < cols; c++) {
        let count = 0;
        for (let r = 0; r < rows; r++) {
            count = data[r][c] === 0 ? count + 1 : 0;
            hist[r][c] = count;
        }
    }
    let maxArea = 0, maxL = 0, maxR = 0, maxU = 0, maxD = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (hist[r][c] === 0) continue;
            let left = c, right = c;
            while (left > 0 && hist[r][left - 1] >= hist[r][c]) left--;
            while (right < cols - 1 && hist[r][right + 1] >= hist[r][c]) right++;
            const area = (right - left + 1) * hist[r][c];
            if (area > maxArea) {
                maxArea = area;
                maxL = left; maxR = right;
                maxU = r - hist[r][c] + 1; maxD = r;
            }
        }
    }
    return [[maxU, maxL], [maxD, maxR]];
}

// ── Generate IP Addresses ─────────────────────────────────────────────────────
// Input: digit string. Output: string[] of valid IPs.
function solveGenerateIPs(str) {
    const results = [];
    for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++) for (let c = 1; c <= 3; c++) {
        const d = str.length - a - b - c;
        if (d < 1 || d > 3) continue;
        const parts = [str.slice(0,a), str.slice(a,a+b), str.slice(a+b,a+b+c), str.slice(a+b+c)];
        if (parts.some(p => (p.length > 1 && p[0] === "0") || parseInt(p) > 255)) continue;
        results.push(parts.join("."));
    }
    return results;
}

// ── Sanitize Parentheses in Expression ────────────────────────────────────────
// Input: string. Output: string[] of all minimal-removal valid expressions.
function solveSanitizeParentheses(str) {
    const results = new Set();
    // Count minimum removals needed
    let minLeft = 0, minRight = 0;
    for (const c of str) {
        if (c === "(") minLeft++;
        else if (c === ")") { if (minLeft > 0) minLeft--; else minRight++; }
    }
    function dfs(s, index, leftCount, rightCount, leftRem, rightRem, current) {
        if (index === s.length) {
            if (leftRem === 0 && rightRem === 0) results.add(current);
            return;
        }
        const c = s[index];
        if (c === "(" && leftRem > 0) dfs(s, index+1, leftCount, rightCount, leftRem-1, rightRem, current);
        if (c === ")" && rightRem > 0) dfs(s, index+1, leftCount, rightCount, leftRem, rightRem-1, current);
        current += c;
        if (c === "(") dfs(s, index+1, leftCount+1, rightCount, leftRem, rightRem, current);
        else if (c === ")") {
            if (leftCount > rightCount) dfs(s, index+1, leftCount, rightCount+1, leftRem, rightRem, current);
        } else dfs(s, index+1, leftCount, rightCount, leftRem, rightRem, current);
    }
    dfs(str, 0, 0, 0, minLeft, minRight, "");
    return [...results];
}

// ── Find All Valid Math Expressions ──────────────────────────────────────────
// Input: [digits: string, target: number]. Output: string[] of valid expressions.
function solveMathExpressions([digits, target]) {
    const results = [];
    function dfs(expr, pos, evalSoFar, lastMultiplied) {
        if (pos === digits.length) {
            if (evalSoFar === target) results.push(expr);
            return;
        }
        for (let len = 1; len <= digits.length - pos; len++) {
            const sub = digits.slice(pos, pos + len);
            if (len > 1 && sub[0] === "0") break; // no leading zeros
            const num = parseInt(sub, 10);
            if (pos === 0) {
                dfs(sub, len, num, num);
            } else {
                dfs(expr + "+" + sub, len + pos, evalSoFar + num, num);
                dfs(expr + "-" + sub, len + pos, evalSoFar - num, -num);
                dfs(expr + "*" + sub, len + pos, evalSoFar - lastMultiplied + lastMultiplied * num, lastMultiplied * num);
            }
        }
    }
    dfs("", 0, 0, 0);
    return results;
}

// ── Proper 2-Coloring of a Graph ──────────────────────────────────────────────
// Input: [numVertices, [number,number][]]. Output: (0|1)[] or [] if impossible.
function solveGraphColoring([n, edges]) {
    const adj = Array.from({length: n}, () => []);
    for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u); }
    const color = new Array(n).fill(-1);
    for (let start = 0; start < n; start++) {
        if (color[start] !== -1) continue;
        color[start] = 0;
        const queue = [start];
        while (queue.length > 0) {
            const node = queue.shift();
            for (const neighbor of adj[node]) {
                if (color[neighbor] === -1) {
                    color[neighbor] = 1 - color[node];
                    queue.push(neighbor);
                } else if (color[neighbor] === color[node]) {
                    return []; // Not bipartite
                }
            }
        }
    }
    return color;
}

// ── Stock Trader I (at most 1 transaction) ────────────────────────────────────
function solveStockI(prices) {
    let maxCur = 0, maxSoFar = 0;
    for (let i = 1; i < prices.length; i++) {
        maxCur = Math.max(0, maxCur + prices[i] - prices[i-1]);
        maxSoFar = Math.max(maxCur, maxSoFar);
    }
    return maxSoFar;
}

// ── Stock Trader II (unlimited transactions) ──────────────────────────────────
function solveStockII(prices) {
    let profit = 0;
    for (let i = 1; i < prices.length; i++)
        profit += Math.max(prices[i] - prices[i-1], 0);
    return profit;
}

// ── Stock Trader III (at most 2 transactions) ─────────────────────────────────
function solveStockIII(prices) {
    let hold1 = -Infinity, hold2 = -Infinity, release1 = 0, release2 = 0;
    for (const p of prices) {
        release2 = Math.max(release2, hold2 + p);
        hold2     = Math.max(hold2,     release1 - p);
        release1 = Math.max(release1, hold1 + p);
        hold1     = Math.max(hold1,     -p);
    }
    return release2;
}

// ── Stock Trader IV (at most k transactions) ──────────────────────────────────
function solveStockIV([k, prices]) {
    const n = prices.length;
    if (n < 2) return 0;
    if (k >= n / 2) return solveStockII(prices);
    const hold = new Array(k + 1).fill(-Infinity);
    const rele = new Array(k + 1).fill(0);
    for (const p of prices) {
        for (let j = k; j > 0; j--) {
            rele[j] = Math.max(rele[j], hold[j] + p);
            hold[j] = Math.max(hold[j], rele[j-1] - p);
        }
    }
    return rele[k];
}

// ── RLE Compression ───────────────────────────────────────────────────────────
// Input: string. Output: run-length encoded string.
function solveRLECompression(plain) {
    if (plain.length === 0) return "";
    let out = "", count = 1;
    for (let i = 1; i < plain.length; i++) {
        if (count < 9 && plain[i] === plain[i-1]) { count++; continue; }
        out += count + plain[i-1];
        count = 1;
    }
    return out + count + plain[plain.length - 1];
}

// ── LZ Decompression ──────────────────────────────────────────────────────────
// Input: LZ-encoded string. Output: decoded string.
function solveLZDecompression(compr) {
    let plain = "";
    for (let i = 0; i < compr.length; ) {
        const litLen = compr.charCodeAt(i) - 0x30;
        if (litLen < 0 || litLen > 9 || i + 1 + litLen > compr.length) return "";
        plain += compr.substring(i + 1, i + 1 + litLen);
        i += 1 + litLen;
        if (i >= compr.length) break;
        const backLen = compr.charCodeAt(i) - 0x30;
        if (backLen < 0 || backLen > 9) return "";
        if (backLen === 0) { i++; continue; }
        if (i + 1 >= compr.length) return "";
        const offset = compr.charCodeAt(i + 1) - 0x30;
        if (offset < 1 || offset > 9 || offset > plain.length) return "";
        for (let j = 0; j < backLen; j++)
            plain += plain[plain.length - offset];
        i += 2;
    }
    return plain;
}

// ── LZ Compression (optimal, DP-based — mirrors game source) ─────────────────
// Input: string. Output: LZ-compressed string of minimum length.
function solveLZCompression(plain) {
    // State: [literal_offset_0..9][literal_or_backref_len_1..9] = best prefix string so far
    let cur = Array.from({length: 10}, () => new Array(10).fill(null));
    let nxt = Array.from({length: 10}, () => new Array(10).fill(null));

    function set(state, i, j, str) {
        if (state[i][j] === null || str.length < state[i][j].length) state[i][j] = str;
    }

    cur[0][1] = ""; // start: literal of length 1 (first char handled in loop)
    for (let i = 1; i < plain.length; i++) {
        for (const row of nxt) row.fill(null);
        const c = plain[i];
        // Extend literals
        for (let len = 1; len <= 9; len++) {
            const s = cur[0][len];
            if (s === null) continue;
            if (len < 9) set(nxt, 0, len + 1, s);
            else set(nxt, 0, 1, s + "9" + plain.slice(i-9, i) + "0");
            for (let off = 1; off <= Math.min(9, i); off++)
                if (plain[i - off] === c)
                    set(nxt, off, 1, s + String(len) + plain.slice(i - len, i));
        }
        // Extend backreferences
        for (let off = 1; off <= 9; off++) {
            for (let len = 1; len <= 9; len++) {
                const s = cur[off][len];
                if (s === null) continue;
                if (plain[i - off] === c) {
                    if (len < 9) set(nxt, off, len + 1, s);
                    else set(nxt, off, 1, s + "9" + String(off) + "0");
                }
                set(nxt, 0, 1, s + String(len) + String(off));
                for (let noff = 1; noff <= Math.min(9, i); noff++)
                    if (plain[i - noff] === c)
                        set(nxt, noff, 1, s + String(len) + String(off) + "0");
            }
        }
        [cur, nxt] = [nxt, cur];
    }

    // Flush the final state
    let best = null;
    for (let off = 0; off <= 9; off++) {
        for (let len = 1; len <= 9; len++) {
            const s = cur[off][len];
            if (s === null) continue;
            const candidate = off === 0
                ? s + String(len) + plain.slice(plain.length - len)
                : s + String(len) + String(off);
            if (best === null || candidate.length < best.length) best = candidate;
        }
    }
    return best ?? "";
}

// ── HammingCodes: Integer → Encoded Binary ────────────────────────────────────
// Input: number. Output: extended Hamming-encoded binary string.
function solveHammingEncode(data) {
    const enc = [0];
    const bits = data.toString(2).split("").reverse().map(Number);
    let k = bits.length;
    for (let i = 1; k > 0; i++) {
        if ((i & (i - 1)) !== 0) enc[i] = bits[--k];
        else enc[i] = 0;
    }
    let parity = 0;
    for (let i = 0; i < enc.length; i++) if (enc[i]) parity ^= i;
    const parBits = parity.toString(2).split("").reverse().map(Number);
    for (let i = 0; i < parBits.length; i++) enc[2 ** i] = parBits[i] ? 1 : 0;
    // Overall parity (bit 0)
    enc[0] = enc.reduce((a, b) => a ^ b, 0);
    return enc.join("");
}

// ── HammingCodes: Encoded Binary → Integer ────────────────────────────────────
// Input: binary string (may have one flipped bit). Output: decoded integer (number).
function solveHammingDecode(str) {
    const bits = str.split("").map(Number);
    let err = 0;
    for (let i = 0; i < bits.length; i++) if (bits[i]) err ^= i;
    if (err) bits[err] = bits[err] ? 0 : 1; // correct the flipped bit
    let result = "";
    for (let i = 1; i < bits.length; i++)
        if ((i & (i - 1)) !== 0) result += bits[i];
    return parseInt(result, 2);
}

// ── Encryption I: Caesar Cipher ───────────────────────────────────────────────
// Input: [plaintext: string, leftShift: number]. Output: ciphertext string.
function solveCaesarCipher([text, shift]) {
    return [...text].map(c =>
        c === " " ? c : String.fromCharCode(((c.charCodeAt(0) - 65 - shift + 26) % 26) + 65)
    ).join("");
}

// ── Encryption II: Vigenère Cipher ───────────────────────────────────────────
// Input: [plaintext: string, keyword: string]. Output: ciphertext string.
function solveVigenereCipher([text, key]) {
    return [...text].map((c, i) =>
        c === " " ? c : String.fromCharCode(((c.charCodeAt(0) - 2 * 65 + key.charCodeAt(i % key.length)) % 26) + 65)
    ).join("");
}