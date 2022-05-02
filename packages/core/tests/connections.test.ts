/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { SubjectMessage } from '../../../tests/transport/SubjectInboundTransport'

import { Subject } from 'rxjs'

import { SubjectInboundTransport } from '../../../tests/transport/SubjectInboundTransport'
import { SubjectOutboundTransport } from '../../../tests/transport/SubjectOutboundTransport'
import { ConnectionState, DidExchangeState, HandshakeProtocol } from '../src'
import { Agent } from '../src/agent/Agent'
import { OutOfBandState } from '../src/modules/oob/domain/OutOfBandState'

import { getBaseConfig } from './helpers'

describe('connections', () => {
  let faberAgent: Agent
  let aliceAgent: Agent

  afterEach(async () => {
    await faberAgent.shutdown()
    await faberAgent.wallet.delete()
    await aliceAgent.shutdown()
    await aliceAgent.wallet.delete()
  })

  it('should be able to make multiple connections using a multi use invite', async () => {
    const faberConfig = getBaseConfig('Faber Agent Connections', {
      endpoints: ['rxjs:faber'],
    })
    const aliceConfig = getBaseConfig('Alice Agent Connections', {
      endpoints: ['rxjs:alice'],
    })

    const faberMessages = new Subject<SubjectMessage>()
    const aliceMessages = new Subject<SubjectMessage>()
    const subjectMap = {
      'rxjs:faber': faberMessages,
      'rxjs:alice': aliceMessages,
    }

    faberAgent = new Agent(faberConfig.config, faberConfig.agentDependencies)
    faberAgent.registerInboundTransport(new SubjectInboundTransport(faberMessages))
    faberAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    await faberAgent.initialize()

    aliceAgent = new Agent(aliceConfig.config, aliceConfig.agentDependencies)
    aliceAgent.registerInboundTransport(new SubjectInboundTransport(aliceMessages))
    aliceAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    await aliceAgent.initialize()

    const faberOutOfBandRecord = await faberAgent.oob.createInvitation({
      handshakeProtocols: [HandshakeProtocol.Connections],
      multiUseInvitation: true,
    })

    const invitation = faberOutOfBandRecord.outOfBandMessage
    const invitationUrl = invitation.toUrl({ domain: 'https://example.com' })

    // Create first connection
    let { connectionRecord: aliceFaberConnection1 } = await aliceAgent.oob.receiveInvitationFromUrl(invitationUrl)
    aliceFaberConnection1 = await aliceAgent.connections.returnWhenIsConnected(aliceFaberConnection1!.id)
    expect(aliceFaberConnection1.state).toBe(DidExchangeState.Completed)

    // Create second connection
    let { connectionRecord: aliceFaberConnection2 } = await aliceAgent.oob.receiveInvitationFromUrl(invitationUrl, {
      reuseConnection: false,
    })
    aliceFaberConnection2 = await aliceAgent.connections.returnWhenIsConnected(aliceFaberConnection2!.id)
    expect(aliceFaberConnection2.state).toBe(DidExchangeState.Completed)

    let faberAliceConnection1 = await faberAgent.connections.getByThreadId(aliceFaberConnection1.threadId!)
    let faberAliceConnection2 = await faberAgent.connections.getByThreadId(aliceFaberConnection2.threadId!)

    faberAliceConnection1 = await faberAgent.connections.returnWhenIsConnected(faberAliceConnection1.id)
    faberAliceConnection2 = await faberAgent.connections.returnWhenIsConnected(faberAliceConnection2.id)

    expect(faberAliceConnection1).toBeConnectedWith(aliceFaberConnection1)
    expect(faberAliceConnection2).toBeConnectedWith(aliceFaberConnection2)

    expect(faberAliceConnection1.id).not.toBe(faberAliceConnection2.id)

    return expect(faberOutOfBandRecord.state).toBe(OutOfBandState.AwaitResponse)
  })

  it('should be able to make multiple connections using a multi use invite', async () => {
    const faberMessages = new Subject<SubjectMessage>()
    const subjectMap = {
      'rxjs:faber': faberMessages,
    }

    const faberConfig = getBaseConfig('Faber Agent Connections 2', {
      endpoints: ['rxjs:faber'],
    })
    const aliceConfig = getBaseConfig('Alice Agent Connections 2')

    // Faber defines both inbound and outbound transports
    faberAgent = new Agent(faberConfig.config, faberConfig.agentDependencies)
    faberAgent.registerInboundTransport(new SubjectInboundTransport(faberMessages))
    faberAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    await faberAgent.initialize()

    // Alice only has outbound transport
    aliceAgent = new Agent(aliceConfig.config, aliceConfig.agentDependencies)
    aliceAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    await aliceAgent.initialize()

    const faberOutOfBandRecord = await faberAgent.oob.createInvitation({
      handshakeProtocols: [HandshakeProtocol.Connections],
      multiUseInvitation: true,
    })

    const invitation = faberOutOfBandRecord.outOfBandMessage
    const invitationUrl = invitation.toUrl({ domain: 'https://example.com' })

    // Create first connection
    let { connectionRecord: aliceFaberConnection1 } = await aliceAgent.oob.receiveInvitationFromUrl(invitationUrl)
    aliceFaberConnection1 = await aliceAgent.connections.returnWhenIsConnected(aliceFaberConnection1!.id)
    expect(aliceFaberConnection1.state).toBe(DidExchangeState.Completed)

    // Create second connection
    let { connectionRecord: aliceFaberConnection2 } = await aliceAgent.oob.receiveInvitationFromUrl(invitationUrl, {
      reuseConnection: false,
    })
    aliceFaberConnection2 = await aliceAgent.connections.returnWhenIsConnected(aliceFaberConnection2!.id)
    expect(aliceFaberConnection2.state).toBe(DidExchangeState.Completed)

    let faberAliceConnection1 = await faberAgent.connections.getByThreadId(aliceFaberConnection1.threadId!)
    let faberAliceConnection2 = await faberAgent.connections.getByThreadId(aliceFaberConnection2.threadId!)

    faberAliceConnection1 = await faberAgent.connections.returnWhenIsConnected(faberAliceConnection1.id)
    faberAliceConnection2 = await faberAgent.connections.returnWhenIsConnected(faberAliceConnection2.id)

    expect(faberAliceConnection1).toBeConnectedWith(aliceFaberConnection1)
    expect(faberAliceConnection2).toBeConnectedWith(aliceFaberConnection2)

    expect(faberAliceConnection1.id).not.toBe(faberAliceConnection2.id)

    return expect(faberOutOfBandRecord.state).toBe(OutOfBandState.AwaitResponse)
  })
})
