const { EventEmitter } = require('events');

const DEFAULT_OPTIONS = {
  windowDurationMs: 60 * 60 * 1000,
  warningStdDevThreshold: 2,
  criticalStdDevThreshold: 3,
  minDataPoints: 10,
  maxHistoryPoints: 1800
};

const METRIC_KEYS = ['cpu.usage', 'memory.usage', 'disk.usage', 'network.upMB', 'network.downMB'];

const METRIC_LABELS = {
  'cpu.usage': 'CPU使用率',
  'memory.usage': '内存使用率',
  'disk.usage': '磁盘使用率',
  'network.upMB': '网络上传速率',
  'network.downMB': '网络下载速率'
};

const METRIC_UNITS = {
  'cpu.usage': '%',
  'memory.usage': '%',
  'disk.usage': '%',
  'network.upMB': ' MB/s',
  'network.downMB': ' MB/s'
};

class SmartAlertEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.history = [];
    this.lastAlertTimes = {};
    this.alertCooldownMs = 30 * 1000;
    this.currentBaselines = {};

    METRIC_KEYS.forEach(key => {
      this.lastAlertTimes[key] = 0;
      this.currentBaselines[key] = {
        mean: 0,
        stdDev: 0,
        warningUpper: 0,
        warningLower: 0,
        criticalUpper: 0,
        criticalLower: 0,
        dataPoints: 0,
        isValid: false
      };
    });
  }

  updateOptions(options) {
    this.options = { ...this.options, ...options };
    this.emit('options-updated', this.options);
  }

  getOptions() {
    return { ...this.options };
  }

  processDataPoint(data) {
    const timestamp = new Date(data.timestamp).getTime();

    this.history.push({ timestamp, data });

    const cutoffTime = timestamp - this.options.windowDurationMs;
    while (this.history.length > 0 && this.history[0].timestamp < cutoffTime) {
      this.history.shift();
    }

    if (this.history.length > this.options.maxHistoryPoints) {
      this.history = this.history.slice(-this.options.maxHistoryPoints);
    }

    const baselines = this.calculateBaselines();
    this.currentBaselines = baselines;

    const alerts = this.checkAlerts(data, baselines, timestamp);

    this.emit('baselines-updated', baselines);

    if (alerts.length > 0) {
      this.emit('alerts', alerts);
    }

    return { baselines, alerts };
  }

  calculateBaselines() {
    const baselines = {};

    METRIC_KEYS.forEach(key => {
      const values = this.history.map(h => this.getNestedValue(h.data, key)).filter(v => v !== null && v !== undefined && !isNaN(v));

      const result = {
        mean: 0,
        stdDev: 0,
        warningUpper: 0,
        warningLower: 0,
        criticalUpper: 0,
        criticalLower: 0,
        dataPoints: values.length,
        isValid: values.length >= this.options.minDataPoints
      };

      if (result.isValid) {
        const n = values.length;
        const sum = values.reduce((a, b) => a + b, 0);
        result.mean = sum / n;

        const squaredDiffs = values.map(v => Math.pow(v - result.mean, 2));
        const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / n;
        result.stdDev = Math.sqrt(avgSquaredDiff);

        result.warningUpper = result.mean + this.options.warningStdDevThreshold * result.stdDev;
        result.warningLower = result.mean - this.options.warningStdDevThreshold * result.stdDev;
        result.criticalUpper = result.mean + this.options.criticalStdDevThreshold * result.stdDev;
        result.criticalLower = result.mean - this.options.criticalStdDevThreshold * result.stdDev;
      }

      baselines[key] = result;
    });

    return baselines;
  }

  checkAlerts(data, baselines, timestamp) {
    const alerts = [];

    METRIC_KEYS.forEach(key => {
      const value = this.getNestedValue(data, key);
      const baseline = baselines[key];

      if (value === null || value === undefined || isNaN(value) || !baseline.isValid) {
        return;
      }

      const deviation = value - baseline.mean;
      const stdDeviations = Math.abs(deviation) / (baseline.stdDev || 1);

      let level = null;
      if (stdDeviations >= this.options.criticalStdDevThreshold) {
        level = 'critical';
      } else if (stdDeviations >= this.options.warningStdDevThreshold) {
        level = 'warning';
      }

      if (level) {
        if (timestamp - this.lastAlertTimes[key] < this.alertCooldownMs) {
          return;
        }

        this.lastAlertTimes[key] = timestamp;

        const direction = deviation > 0 ? '偏高' : '偏低';
        const label = METRIC_LABELS[key] || key;
        const unit = METRIC_UNITS[key] || '';

        alerts.push({
          type: 'smart',
          metricKey: key,
          level,
          message: `${label}${direction}: ${value.toFixed(2)}${unit} (偏离基线 ${stdDeviations.toFixed(1)}σ)`,
          value,
          mean: baseline.mean,
          stdDev: baseline.stdDev,
          stdDeviations,
          warningThreshold: baseline.warningUpper,
          criticalThreshold: baseline.criticalUpper,
          timestamp: new Date(timestamp).toISOString(),
          isStatistical: true
        });
      }
    });

    return alerts;
  }

  getBaselines() {
    return { ...this.currentBaselines };
  }

  getHistory(windowMs = null) {
    if (!windowMs) {
      return [...this.history];
    }
    const cutoff = Date.now() - windowMs;
    return this.history.filter(h => h.timestamp >= cutoff);
  }

  getMetricHistory(metricKey, windowMs = null) {
    const history = windowMs ? this.getHistory(windowMs) : this.history;
    return history.map(h => ({
      timestamp: h.timestamp,
      value: this.getNestedValue(h.data, metricKey)
    })).filter(h => h.value !== null && h.value !== undefined && !isNaN(h.value));
  }

  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : null;
    }, obj);
  }

  getMetricKeys() {
    return [...METRIC_KEYS];
  }

  getMetricLabels() {
    return { ...METRIC_LABELS };
  }

  getMetricUnits() {
    return { ...METRIC_UNITS };
  }

  reset() {
    this.history = [];
    METRIC_KEYS.forEach(key => {
      this.lastAlertTimes[key] = 0;
    });
    this.emit('reset');
  }
}

module.exports = SmartAlertEngine;
