import { Angelic } from '../../src/angelic'
import worker, { Inbox } from '../../src/index'

// Fault/timer injection stays in a test-only subclass; production exports no hooks.
export class TestAngelic extends Angelic {
  corruptOwnKey() {
    this.state.sub.keys.privateKey = { kty: 'EC' }
  }
  async sendHeartbeat() {
    this.conn.pingAt = Date.now() - 1
    await this.alarm()
  }
  async expirePong() {
    this.conn.pongBy = Date.now() - 1
    await this.alarm()
  }
}
export { Inbox }
export default worker
