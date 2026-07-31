'use strict'

/*
 * A vertical history graph: time runs down the page, one narrow panel per
 * channel, the way a chartplotter draws its wind history. The box always spans
 * the whole requested window, so a partial hour leaves the missing part blank
 * instead of stretching its data across it, and each panel scales to its own
 * channel's range, labelled min / mid / max above the plot.
 *
 * Deliberately generic: the caller names the channels, their units and how to
 * convert the raw (SI) values, so the same module draws any set of scalar
 * series over any window.
 *
 *   VGraph.render(host, {
 *     from, to,                          // ms; the span the box always covers
 *     samples: [{ t, twd, tws, ... }],   // one row per bucket, nulls allowed
 *     channels: [{ key, label, unit, decimals, map, wrap, color, smoothSeconds,
 *                 summary }],
 *     pxPerMinute, gridMinutes, locale, axisLabel, emptyText, smoothSeconds,
 *     newestAtTop
 *   })
 *
 * `newestAtTop` puts the end of the window at the top edge and runs the history
 * downwards from it, the way a plotter draws the last half hour behind you; the
 * default runs the window forwards down the box. Either way the axis counts
 * minutes from the top edge.
 *
 * `smoothSeconds` runs a centred moving average of that width over a channel
 * before it is drawn (0 draws the samples as they came); a channel may override
 * the graph-wide setting with its own.
 *
 * `summary` is the figure shown beside the channel's label, in the same units
 * the samples arrive in. Pass it wherever the caller already holds the number
 * (the row of statistics this graph belongs to, say) so the two agree exactly;
 * without it the panel shows the mean of what it drew, which is a different
 * statistic over a different set of samples.
 *
 * `wrap` marks a circular channel (360 for degrees): the series is unwrapped
 * before it is scaled, so a wind veering through north draws as one continuous
 * line rather than falling off the top of the panel, and the labels are taken
 * back into 0–360.
 */

window.VGraph = (function () {
  const DEFAULTS = {
    pxPerMinute: 4,
    gridMinutes: 10,
    locale: 'en',
    axisLabel: 'min',
    emptyText: '–',
    smoothSeconds: 0,
    newestAtTop: false
  }

  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  }

  function num (v, decimals, locale) {
    return v == null || !Number.isFinite(v)
      ? '–'
      : v.toLocaleString(locale, {
        minimumFractionDigits: decimals || 0,
        maximumFractionDigits: decimals || 0
      })
  }

  // Continue a circular series past its wraparound: each value is moved by whole
  // periods to sit nearest the one before it, so 359 → 3 becomes 359 → 363.
  function unwrap (points, period) {
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].v
      points[i].v += Math.round((prev - points[i].v) / period) * period
    }
  }

  // The typical gap between samples, used to tell a hole in the data (which the
  // line should break across) from the normal step.
  function medianStep (samples) {
    const gaps = []
    for (let i = 1; i < samples.length; i++) {
      gaps.push(samples[i].t - samples[i - 1].t)
    }
    if (!gaps.length) {
      return 0
    }
    gaps.sort((a, b) => a - b)
    return gaps[Math.floor(gaps.length / 2)]
  }

  // A gentle centred moving average over `seconds` of samples, to settle sensor
  // hair without moving the turns it is drawn to show. Run after unwrapping, so
  // a circular channel averages continuous numbers rather than jumping the
  // wraparound, and never averaged across a hole in the data.
  function smooth (points, seconds, gapMs) {
    const half = seconds * 500
    return points.map((p, i) => {
      let sum = p.v
      let count = 1
      for (let j = i - 1; j >= 0 && p.t - points[j].t <= half; j--) {
        if (points[j + 1].t - points[j].t > gapMs) {
          break
        }
        sum += points[j].v
        count++
      }
      for (let j = i + 1; j < points.length && points[j].t - p.t <= half; j++) {
        if (points[j].t - points[j - 1].t > gapMs) {
          break
        }
        sum += points[j].v
        count++
      }
      return { t: p.t, v: sum / count }
    })
  }

  // The channel's samples as [{ t, v }], converted to display units, unwrapped
  // if circular, smoothed if asked, and with the scale and mean the panel is
  // labelled with. The scale follows the drawn line, not the raw samples, so the
  // curve still spans the panel exactly.
  function channelData (channel, samples, opts) {
    let points = []
    for (const s of samples) {
      const raw = s[channel.key]
      if (raw == null) {
        continue
      }
      const v = channel.map ? channel.map(raw) : raw
      if (v != null && Number.isFinite(v)) {
        points.push({ t: s.t, v })
      }
    }
    if (!points.length) {
      return { points, lo: null, hi: null, mean: null }
    }
    if (channel.wrap) {
      unwrap(points, channel.wrap)
    }
    const seconds = channel.smoothSeconds != null ? channel.smoothSeconds : opts.smoothSeconds
    if (seconds > 0) {
      points = smooth(points, seconds, opts.gapMs)
    }
    let lo = Infinity
    let hi = -Infinity
    let sum = 0
    let sinSum = 0
    let cosSum = 0
    for (const p of points) {
      lo = Math.min(lo, p.v)
      hi = Math.max(hi, p.v)
      sum += p.v
      if (channel.wrap) {
        const a = (p.v * 2 * Math.PI) / channel.wrap
        sinSum += Math.sin(a)
        cosSum += Math.cos(a)
      }
    }
    // A circular channel's mean is the direction of the summed unit vectors: the
    // arithmetic mean would be pulled off by however far the unwrapped series has
    // drifted from where it started, and is meaningless for a compass direction.
    let mean = sum / points.length
    if (channel.wrap) {
      let a = Math.atan2(sinSum, cosSum)
      if (a < 0) {
        a += 2 * Math.PI
      }
      mean = (a * channel.wrap) / (2 * Math.PI)
    }
    // A dead-flat channel would divide by zero; give the plot a nominal span so
    // its line sits down the middle of the panel. Only the plot: the labels keep
    // the real range, or a channel pinned at 0 would be labelled -0.5 to 0.5 and
    // one pinned at north would read 360 / 0 / 1.
    let plotLo = lo
    let plotHi = hi
    if (hi - lo < 1e-9) {
      const pad = Math.max(Math.abs(hi) * 0.01, 0.5)
      plotLo -= pad
      plotHi += pad
    }
    return { points, lo, hi, plotLo, plotHi, mean }
  }

  // Take a label value back into 0–period for a circular channel.
  function display (v, channel) {
    if (v == null || !channel.wrap) {
      return v
    }
    const m = v % channel.wrap
    return m < 0 ? m + channel.wrap : m
  }

  // The plot itself: grid, midline and the line, broken wherever the data has a
  // hole. x runs 0–100 (the viewBox stretches it to the panel width, with the
  // strokes kept at their nominal width), y is in pixels so a minute is always
  // pxPerMinute high whatever the panel's width.
  function plotSvg (data, opts) {
    const { from, to, height, gridMinutes, gapMs } = opts
    const span = to - from
    const y = (t) => (opts.newestAtTop ? (to - t) / span : (t - from) / span) * height
    const grid = []
    for (let m = gridMinutes; m * 60000 < span; m += gridMinutes) {
      const gy = ((m * 60000) / span * height).toFixed(1)
      grid.push(`<line x1="0" y1="${gy}" x2="100" y2="${gy}" vector-effect="non-scaling-stroke"/>`)
    }
    grid.push(`<line x1="50" y1="0" x2="50" y2="${height}" vector-effect="non-scaling-stroke"/>`)

    const lines = []
    if (data.points.length) {
      const x = (v) => ((v - data.plotLo) / (data.plotHi - data.plotLo)) * 100
      let seg = []
      const flush = () => {
        if (seg.length > 1) {
          lines.push(`<polyline class="vg-line" points="${seg.join(' ')}" vector-effect="non-scaling-stroke"/>`)
        } else if (seg.length === 1) {
          // Kept a radius clear of the edges: a lone sample at the very top (the
          // marker's own moment, with nothing yet behind it) would otherwise be
          // half cut off by the plot's clipping.
          const [px, py] = seg[0].split(',')
          const cy = Math.min(height - 1, Math.max(1, parseFloat(py)))
          lines.push(`<circle class="vg-dot" cx="${px}" cy="${cy}" r="1" vector-effect="non-scaling-stroke"/>`)
        }
        seg = []
      }
      let prev = null
      for (const p of data.points) {
        if (prev != null && p.t - prev > gapMs) {
          flush()
        }
        seg.push(`${x(p.v).toFixed(2)},${y(p.t).toFixed(1)}`)
        prev = p.t
      }
      flush()
    }
    return `<svg class="vg-svg" width="100%" height="${height}" viewBox="0 0 100 ${height}"
      preserveAspectRatio="none" aria-hidden="true">
      <g class="vg-grid">${grid.join('')}</g>${lines.join('')}</svg>`
  }

  function panelHtml (channel, samples, opts) {
    const data = channelData(channel, samples, opts)
    const unit = channel.unit || ''
    // The caller's own figure wins, so the panel never quietly disagrees with
    // the statistics it was opened from.
    const given = channel.summary != null && channel.map ? channel.map(channel.summary) : channel.summary
    const mean = given != null ? given : data.mean
    const summary = mean != null
      ? `${num(display(mean, channel), channel.decimals, opts.locale)}${unit}`
      : opts.emptyText
    const scale = data.lo == null
      ? ['', '', '']
      : [data.lo, (data.lo + data.hi) / 2, data.hi].map((v) =>
        num(display(v, channel), channel.decimals, opts.locale))
    const style = channel.color ? ` style="--vg-color:${esc(channel.color)}"` : ''
    return `<div class="vg-col vg-panel"${style}>
      <div class="vg-title">${esc(channel.label)} <span class="vg-sum">${esc(summary)}</span></div>
      <div class="vg-scale"><span>${esc(scale[0])}</span><span>${esc(scale[1])}</span><span>${esc(scale[2])}</span></div>
      <div class="vg-plot">${plotSvg(data, opts)}</div>
    </div>`
  }

  // The shared time axis down the left: minutes from the start of the window.
  // Its (blank) title and scale rows keep it lined up with the panels beside it.
  function axisHtml (opts) {
    const { from, to, height, gridMinutes } = opts
    const span = to - from
    const ticks = []
    for (let m = 0; m * 60000 <= span; m += gridMinutes) {
      const ty = ((m * 60000) / span) * height
      ticks.push(`<span class="vg-tick" style="top:${ty.toFixed(1)}px">${num(m, 0, opts.locale)}</span>`)
    }
    return `<div class="vg-col vg-axis">
      <div class="vg-title">${esc(opts.axisLabel)}</div>
      <div class="vg-scale"><span>&nbsp;</span><span></span><span></span></div>
      <div class="vg-ticks" style="height:${height}px">${ticks.join('')}</div>
    </div>`
  }

  function render (host, options) {
    const opts = Object.assign({}, DEFAULTS, options)
    const samples = (opts.samples || []).slice().sort((a, b) => a.t - b.t)
    opts.height = Math.round(((opts.to - opts.from) / 60000) * opts.pxPerMinute)
    // Break the line across a hole a few samples wide, but not across the normal
    // step; with no series to measure, only a real minute-long gap counts.
    opts.gapMs = Math.max(4 * medianStep(samples), 60000)
    host.innerHTML = `<div class="vgraph">${axisHtml(opts)}${
      opts.channels.map((c) => panelHtml(c, samples, opts)).join('')}</div>`
  }

  return { render }
})()
