/** Seconds the wind takes to get most of the way (63%) to where it is heading. */
const EASE = 10
/** At full variability, how far one change turns the wind (degrees) and how far its speed strays from the set speed (fraction). */
const MAX_TURN = 90
const MAX_GUST = 1

/**
 * The wind as it blows now. Manual (params windAuto off): exactly the set
 * wind (windDirection, cloudSpeed). Auto: every `windChangeEvery` s or so
 * (varied) it settles on a new direction (turning up to MAX_TURN x
 * `windVariability` from where it blows) and strength (around the set
 * speed, by up to MAX_GUST x `windVariability`), and eases there over EASE
 * s, so it never jumps.
 */
export class Wind {
  constructor() {
    this.direction = null // degrees, clockwise from north (screen up)
    this.speed = 0 // px/s
  }

  /** Fastest it can blow with these params (px/s). */
  static maxSpeed(p) {
    return p.cloudSpeed * (1 + MAX_GUST * p.windVariability)
  }

  update(dt, p) {
    if (!p.windAuto || this.direction == null) {
      this.direction = p.windDirection
      this.speed = p.cloudSpeed
      this.clock = 0
      if (!p.windAuto) return
    }
    this.clock -= dt
    if (this.clock <= 0 || p.cloudSpeed !== this.setSpeed || p.windVariability !== this.setVariability) {
      this.setSpeed = p.cloudSpeed
      this.setVariability = p.windVariability
      this.clock = p.windChangeEvery * (0.5 + Math.random())
      const v = p.windVariability
      this.toDirection = this.direction + (Math.random() * 2 - 1) * MAX_TURN * v
      this.toSpeed = Math.max(0, p.cloudSpeed * (1 + (Math.random() * 2 - 1) * MAX_GUST * v))
    }
    const k = 1 - Math.exp(-dt / EASE)
    const turn = ((((this.toDirection - this.direction) % 360) + 540) % 360) - 180 // the short way round
    this.direction = (this.direction + turn * k + 360) % 360
    this.speed += (this.toSpeed - this.speed) * k
  }
}
