import type { AgentMessage } from '../../agent/AgentMessage'
import type { AgentMessageReceivedEvent } from '../../agent/Events'
import type { Logger } from '../../logger'
import type { ConnectionRecord, Routing } from '../../modules/connections'
import type { PlaintextMessage } from '../../types'
import type { Key } from '../dids'

import { parseUrl } from 'query-string'
import { EmptyError } from 'rxjs'
import { Lifecycle, scoped } from 'tsyringe'

import { AgentConfig } from '../../agent/AgentConfig'
import { Dispatcher } from '../../agent/Dispatcher'
import { EventEmitter } from '../../agent/EventEmitter'
import { AgentEventTypes } from '../../agent/Events'
import { MessageSender } from '../../agent/MessageSender'
import { createOutboundMessage } from '../../agent/helpers'
import { ServiceDecorator } from '../../decorators/service/ServiceDecorator'
import { AriesFrameworkError } from '../../error'
import {
  DidExchangeState,
  HandshakeProtocol,
  ConnectionInvitationMessage,
  ConnectionsModule,
} from '../../modules/connections'
import { JsonTransformer } from '../../utils'
import { DidsModule } from '../dids'
import { didKeyToVerkey, verkeyToDidKey } from '../dids/helpers'
import { outOfBandServiceToNumAlgo2Did } from '../dids/methods/peer/peerDidNumAlgo2'
import { MediationRecipientService } from '../routing'

import { OutOfBandService } from './OutOfBandService'
import { OutOfBandDidCommService } from './domain/OutOfBandDidCommService'
import { OutOfBandRole } from './domain/OutOfBandRole'
import { OutOfBandState } from './domain/OutOfBandState'
import { HandshakeReuseHandler } from './handlers'
import { convertToNewInvitation, convertToOldInvitation } from './helpers'
import { OutOfBandInvitation, HandshakeReuseMessage } from './messages'
import { OutOfBandRecord } from './repository/OutOfBandRecord'

const didCommProfiles = ['didcomm/aip1', 'didcomm/aip2;env=rfc19']

export interface CreateOutOfBandInvitationConfig {
  label?: string
  alias?: string
  imageUrl?: string
  goalCode?: string
  goal?: string
  handshake?: boolean
  handshakeProtocols?: HandshakeProtocol[]
  messages?: AgentMessage[]
  multiUseInvitation?: boolean
  autoAcceptConnection?: boolean
  routing?: Routing
}

export interface ReceiveOutOfBandInvitationConfig {
  label?: string
  alias?: string
  imageUrl?: string
  autoAcceptInvitation?: boolean
  autoAcceptConnection?: boolean
  reuseConnection?: boolean
  routing?: Routing
}

@scoped(Lifecycle.ContainerScoped)
export class OutOfBandModule {
  private outOfBandService: OutOfBandService
  private mediationRecipientService: MediationRecipientService
  private connectionsModule: ConnectionsModule
  private dids: DidsModule
  private dispatcher: Dispatcher
  private messageSender: MessageSender
  private eventEmitter: EventEmitter
  private agentConfig: AgentConfig
  private logger: Logger

  public constructor(
    dispatcher: Dispatcher,
    agentConfig: AgentConfig,
    outOfBandService: OutOfBandService,
    mediationRecipientService: MediationRecipientService,
    connectionsModule: ConnectionsModule,
    dids: DidsModule,
    messageSender: MessageSender,
    eventEmitter: EventEmitter
  ) {
    this.dispatcher = dispatcher
    this.agentConfig = agentConfig
    this.logger = agentConfig.logger
    this.outOfBandService = outOfBandService
    this.mediationRecipientService = mediationRecipientService
    this.connectionsModule = connectionsModule
    this.dids = dids
    this.messageSender = messageSender
    this.eventEmitter = eventEmitter
    this.registerHandlers(dispatcher)
  }

  /**
   * Creates an outbound out-of-band record containing out-of-band invitation message defined in
   * Aries RFC 0434: Out-of-Band Protocol 1.1.
   *
   * It automatically adds all supported handshake protocols by agent to `hanshake_protocols`. You
   * can modify this by setting `handshakeProtocols` in `config` parameter. If you want to create
   * invitation without handhsake, you can set `handshake` to `false`.
   *
   * If `config` parameter contains `messages` it adds them to `requests~attach` attribute.
   *
   * Agent role: sender (inviter)
   *
   * @param config configuration of how out-of-band invitation should be created
   * @returns out-of-band record
   */
  public async createInvitation(config: CreateOutOfBandInvitationConfig = {}): Promise<OutOfBandRecord> {
    const multiUseInvitation = config.multiUseInvitation ?? false
    const handshake = config.handshake ?? true
    const customHandshakeProtocols = config.handshakeProtocols
    const autoAcceptConnection = config.autoAcceptConnection ?? this.agentConfig.autoAcceptConnections
    const messages = config.messages
    const label = config.label ?? this.agentConfig.label
    const imageUrl = config.imageUrl ?? this.agentConfig.connectionImageUrl

    if (!handshake && !messages) {
      throw new AriesFrameworkError(
        'One or both of handshake_protocols and requests~attach MUST be included in the message.'
      )
    }

    if (!handshake && customHandshakeProtocols) {
      throw new AriesFrameworkError(`Attribute 'handshake' can not be 'false' when 'handshakeProtocols' is defined.`)
    }

    let handshakeProtocols
    if (handshake) {
      // Find first supported handshake protocol preserving the order of handshake protocols defined
      // by agent
      if (customHandshakeProtocols) {
        this.assertHandshakeProtocols(customHandshakeProtocols)
        handshakeProtocols = customHandshakeProtocols
      } else {
        handshakeProtocols = this.getSupportedHandshakeProtocols()
      }
    }

    const routing = config.routing ?? (await this.mediationRecipientService.getRouting({}))

    const services = routing.endpoints.map((endpoint, index) => {
      return new OutOfBandDidCommService({
        id: `#inline-${index}`,
        serviceEndpoint: endpoint,
        recipientKeys: [routing.verkey].map(verkeyToDidKey),
        routingKeys: routing.routingKeys.map(verkeyToDidKey),
      })
    })

    const options = {
      label,
      goal: config.goal,
      goalCode: config.goalCode,
      imageUrl,
      accept: didCommProfiles,
      services,
      handshakeProtocols,
    }
    const outOfBandInvitation = new OutOfBandInvitation(options)

    if (messages) {
      messages.forEach((message) => {
        if (message.service) {
          // We can remove `~service` attribute from message. Newer OOB messages have `services` attribute instead.
          message.service = undefined
        }
        outOfBandInvitation.addRequest(message)
      })
    }

    const outOfBandRecord = new OutOfBandRecord({
      did: routing.did,
      mediatorId: routing.mediatorId,
      role: OutOfBandRole.Sender,
      state: OutOfBandState.AwaitResponse,
      outOfBandInvitation: outOfBandInvitation,
      reusable: multiUseInvitation,
      autoAcceptConnection,
    })
    await this.outOfBandService.save(outOfBandRecord)

    return outOfBandRecord
  }

  /**
   * Creates an outbound out-of-band record in the same way how `createInvitation` method does it,
   * but it also converts out-of-band invitation message to an "legacy" invitation message defined
   * in RFC 0160: Connection Protocol and returns it together with out-of-band record.
   *
   * Agent role: sender (inviter)
   *
   * @param config configuration of how out-of-band invitation should be created
   * @returns out-of-band record and connection invitation
   */
  public async createLegacyInvitation(config: CreateOutOfBandInvitationConfig = {}) {
    if (config.handshake === false) {
      throw new AriesFrameworkError(
        `Invalid value of handshake in config. Value is ${config.handshake}, but this method supports only 'true' or 'undefined'.`
      )
    }
    if (
      !config.handshakeProtocols ||
      (config.handshakeProtocols?.length === 1 && config.handshakeProtocols.includes(HandshakeProtocol.Connections))
    ) {
      const outOfBandRecord = await this.createInvitation({
        ...config,
        handshakeProtocols: [HandshakeProtocol.Connections],
      })
      return { outOfBandRecord, invitation: convertToOldInvitation(outOfBandRecord.outOfBandInvitation) }
    }
    throw new AriesFrameworkError(
      `Invalid value of handshakeProtocols in config. Value is ${config.handshakeProtocols}, but this method supports only ${HandshakeProtocol.Connections}.`
    )
  }

  /**
   * Parses URL, decodes invitation and calls `receiveMessage` with parsed invitation message.
   *
   * Agent role: receiver (invitee)
   *
   * @param invitationUrl url containing a base64 encoded invitation to receive
   * @param config configuration of how out-of-band invitation should be processed
   * @returns out-of-band record and connection record if one has been created
   */
  public async receiveInvitationFromUrl(invitationUrl: string, config: ReceiveOutOfBandInvitationConfig = {}) {
    const message = await this.parseInvitation(invitationUrl)
    return this.receiveInvitation(message, config)
  }

  /**
   * Parses URL containing encoded invitation and returns invitation message.
   *
   * @param invitationUrl URL containing encoded invitation
   *
   * @returns OutOfBandInvitation
   */
  public async parseInvitation(invitationUrl: string) {
    const parsedUrl = parseUrl(invitationUrl).query
    if (parsedUrl['oob']) {
      const outOfBandInvitation = await OutOfBandInvitation.fromUrl(invitationUrl)
      return outOfBandInvitation
    } else if (parsedUrl['c_i'] || parsedUrl['d_m']) {
      const invitation = await ConnectionInvitationMessage.fromUrl(invitationUrl)
      return convertToNewInvitation(invitation)
    }
    throw new AriesFrameworkError(
      'InvitationUrl is invalid. It needs to contain one, and only one, of the following parameters: `oob`, `c_i` or `d_m`.'
    )
  }

  /**
   * Creates inbound out-of-band record and assigns out-of-band invitation message to it if the
   * message is valid. It automatically passes out-of-band invitation for further processing to
   * `acceptInvitation` method. If you don't want to do that you can set `autoAcceptInvitation`
   * attribute in `config` parameter to `false` and accept the message later by calling
   * `acceptInvitation`.
   *
   * It supports both OOB (Aries RFC 0434: Out-of-Band Protocol 1.1) and Connection Invitation
   * (0160: Connection Protocol).
   *
   * Agent role: receiver (invitee)
   *
   * @param outOfBandInvitation
   * @param config config for handling of invitation
   *
   * @returns out-of-band record and connection record if one has been created.
   */
  public async receiveInvitation(
    outOfBandInvitation: OutOfBandInvitation,
    config: ReceiveOutOfBandInvitationConfig = {}
  ): Promise<{ outOfBandRecord: OutOfBandRecord; connectionRecord?: ConnectionRecord }> {
    const { handshakeProtocols } = outOfBandInvitation
    const { routing } = config

    const autoAcceptInvitation = config.autoAcceptInvitation ?? true
    const autoAcceptConnection = config.autoAcceptConnection ?? true
    const reuseConnection = config.reuseConnection ?? false
    const label = config.label ?? this.agentConfig.label
    const alias = config.alias
    const imageUrl = config.imageUrl ?? this.agentConfig.connectionImageUrl

    const messages = outOfBandInvitation.getRequests()

    if ((!handshakeProtocols || handshakeProtocols.length === 0) && (!messages || messages?.length === 0)) {
      throw new AriesFrameworkError(
        'One or both of handshake_protocols and requests~attach MUST be included in the message.'
      )
    }

    const outOfBandRecord = new OutOfBandRecord({
      role: OutOfBandRole.Receiver,
      state: OutOfBandState.Initial,
      outOfBandInvitation: outOfBandInvitation,
      autoAcceptConnection,
    })
    await this.outOfBandService.save(outOfBandRecord)

    if (autoAcceptInvitation) {
      return await this.acceptInvitation(outOfBandRecord.id, {
        label,
        alias,
        imageUrl,
        autoAcceptConnection,
        reuseConnection,
        routing,
      })
    }

    return { outOfBandRecord }
  }

  /**
   * Creates a connection if the out-of-band invitation message contains `handshake_protocols`
   * attribute, except for the case when connection already exists and `reuseConnection` is enabled.
   *
   * It passes first supported message from `requests~attach` attribute to the agent, except for the
   * case reuse of connection is applied when it just sends `handshake-reuse` message to existing
   * connection.
   *
   * Agent role: receiver (invitee)
   *
   * @param outOfBandId
   * @param config
   * @returns out-of-band record and connection record if one has been created.
   */
  public async acceptInvitation(
    outOfBandId: string,
    config: {
      autoAcceptConnection?: boolean
      reuseConnection?: boolean
      label?: string
      alias?: string
      imageUrl?: string
      mediatorId?: string
      routing?: Routing
    }
  ) {
    const outOfBandRecord = await this.outOfBandService.getById(outOfBandId)

    const { outOfBandInvitation } = outOfBandRecord
    const { label, alias, imageUrl, autoAcceptConnection, reuseConnection, routing } = config
    const { handshakeProtocols, services } = outOfBandInvitation
    const messages = outOfBandInvitation.getRequests()

    const existingConnection = await this.findExistingConnection(services)

    await this.outOfBandService.updateState(outOfBandRecord, OutOfBandState.PrepareResponse)

    if (handshakeProtocols) {
      this.logger.debug('Out of band message contains handshake protocols.')

      let connectionRecord
      if (existingConnection && reuseConnection) {
        this.logger.debug(
          `Connection already exists and reuse is enabled. Reusing an existing connection with ID ${existingConnection.id}.`
        )
        connectionRecord = existingConnection
        if (!messages) {
          this.logger.debug('Out of band message does not contain any request messages.')
          await this.sendReuse(outOfBandInvitation, connectionRecord)
        }
      } else {
        this.logger.debug('Connection does not exist or reuse is disabled. Creating a new connection.')
        // Find first supported handshake protocol preserving the order of handshake protocols
        // defined by `handshake_protocols` attribute in the invitation message
        const handshakeProtocol = this.getFirstSupportedProtocol(handshakeProtocols)
        connectionRecord = await this.connectionsModule.acceptOutOfBandInvitation(outOfBandRecord, {
          label,
          alias,
          imageUrl,
          autoAcceptConnection,
          protocol: handshakeProtocol,
          routing,
        })
      }

      if (messages) {
        this.logger.debug('Out of band message contains request messages.')
        if (connectionRecord.isReady) {
          await this.emitWithConnection(connectionRecord, messages)
        } else {
          // Wait until the connection is ready and then pass the messages to the agent for further processing
          this.connectionsModule
            .returnWhenIsConnected(connectionRecord.id)
            .then((connectionRecord) => this.emitWithConnection(connectionRecord, messages))
            .catch((error) => {
              if (error instanceof EmptyError) {
                this.logger.warn(
                  `Agent unsubscribed before connection got into ${DidExchangeState.Completed} state`,
                  error
                )
              } else {
                this.logger.error('Promise waiting for the connection to be complete failed.', error)
              }
            })
        }
      }
      return { outOfBandRecord, connectionRecord }
    } else if (messages) {
      this.logger.debug('Out of band message contains only request messages.')
      if (existingConnection) {
        this.logger.debug('Connection already exists.', { connectionId: existingConnection.id })
        await this.emitWithConnection(existingConnection, messages)
      } else {
        await this.emitWithServices(services, messages)
      }
    }
    return { outOfBandRecord }
  }

  public async findByRecipientKey(recipientKey: Key) {
    return this.outOfBandService.findByRecipientKey(recipientKey)
  }

  public async findByMessageId(messageId: string) {
    return this.outOfBandService.findByMessageId(messageId)
  }

  private assertHandshakeProtocols(handshakeProtocols: HandshakeProtocol[]) {
    if (!this.areHandshakeProtocolsSupported(handshakeProtocols)) {
      const supportedProtocols = this.getSupportedHandshakeProtocols()
      throw new AriesFrameworkError(
        `Handshake protocols [${handshakeProtocols}] are not supported. Supported protocols are [${supportedProtocols}]`
      )
    }
  }

  private areHandshakeProtocolsSupported(handshakeProtocols: HandshakeProtocol[]) {
    const supportedProtocols = this.getSupportedHandshakeProtocols()
    return handshakeProtocols.every((p) => supportedProtocols.includes(p))
  }

  private getSupportedHandshakeProtocols(): HandshakeProtocol[] {
    const handshakeMessageFamilies = ['https://didcomm.org/didexchange', 'https://didcomm.org/connections']
    const handshakeProtocols = this.dispatcher.filterSupportedProtocolsByMessageFamilies(handshakeMessageFamilies)

    if (handshakeProtocols.length === 0) {
      throw new AriesFrameworkError('There is no handshake protocol supported. Agent can not create a connection.')
    }

    // Order protocols according to `handshakeMessageFamilies` array
    const orderedProtocols = handshakeMessageFamilies
      .map((messageFamily) => handshakeProtocols.find((p) => p.startsWith(messageFamily)))
      .filter((item): item is string => !!item)

    return orderedProtocols as HandshakeProtocol[]
  }

  private getFirstSupportedProtocol(handshakeProtocols: HandshakeProtocol[]) {
    const supportedProtocols = this.getSupportedHandshakeProtocols()
    const handshakeProtocol = handshakeProtocols.find((p) => supportedProtocols.includes(p))
    if (!handshakeProtocol) {
      throw new AriesFrameworkError(
        `Handshake protocols [${handshakeProtocols}] are not supported. Supported protocols are [${supportedProtocols}]`
      )
    }
    return handshakeProtocol
  }

  private async findExistingConnection(services: Array<OutOfBandDidCommService | string>) {
    this.logger.debug('Searching for an existing connection for out-of-band invitation services.', { services })

    // TODO: for each did we should look for a connection with the invitation did OR a connection with theirDid that matches the service did
    for (const didOrService of services) {
      if (typeof didOrService === 'string') {
        // TODO await this.connectionsModule.findByTheirDid()
        throw new AriesFrameworkError('Dids are not currently supported in out-of-band message services attribute.')
      }

      const did = outOfBandServiceToNumAlgo2Did(didOrService)
      const connections = await this.connectionsModule.findByInvitationDid(did)
      this.logger.debug(`Retrieved ${connections.length} connections for invitation did ${did}`)

      if (connections.length === 1) {
        const [firstConnection] = connections
        return firstConnection
      } else if (connections.length > 1) {
        this.logger.warn(`There is more than one connection created from invitationDid ${did}. Taking the first one.`)
        const [firstConnection] = connections
        return firstConnection
      }
      return null
    }
  }

  private async emitWithConnection(connectionRecord: ConnectionRecord, messages: PlaintextMessage[]) {
    const plaintextMessage = messages.find((message) =>
      this.dispatcher.supportedMessageTypes.find((type) => type === message['@type'])
    )

    if (!plaintextMessage) {
      throw new AriesFrameworkError('There is no message in requests~attach supported by agent.')
    }

    this.logger.debug(`Message with type ${plaintextMessage['@type']} can be processed.`)

    this.eventEmitter.emit<AgentMessageReceivedEvent>({
      type: AgentEventTypes.AgentMessageReceived,
      payload: {
        message: plaintextMessage,
        connection: connectionRecord,
      },
    })
  }

  private async emitWithServices(services: Array<OutOfBandDidCommService | string>, messages: PlaintextMessage[]) {
    if (!services || services.length === 0) {
      throw new AriesFrameworkError(`There are no services. We can not emit messages`)
    }

    const plaintextMessage = messages.find((message) =>
      this.dispatcher.supportedMessageTypes.find((type) => type === message['@type'])
    )

    if (!plaintextMessage) {
      throw new AriesFrameworkError('There is no message in requests~attach supported by agent.')
    }

    this.logger.debug(`Message with type ${plaintextMessage['@type']} can be processed.`)

    // The framework currently supports only older OOB messages with `~service` decorator.
    // TODO: support receiving messages with other services so we don't have to transform the service
    // to ~service decorator
    const [service] = services

    if (typeof service === 'string') {
      throw new AriesFrameworkError('Dids are not currently supported in out-of-band message services attribute.')
    }

    const serviceDecorator = new ServiceDecorator({
      recipientKeys: service.recipientKeys.map(didKeyToVerkey),
      routingKeys: service.routingKeys?.map(didKeyToVerkey) || [],
      serviceEndpoint: service.serviceEndpoint,
    })

    plaintextMessage['~service'] = JsonTransformer.toJSON(serviceDecorator)
    this.eventEmitter.emit<AgentMessageReceivedEvent>({
      type: AgentEventTypes.AgentMessageReceived,
      payload: {
        message: plaintextMessage,
      },
    })
  }

  private async sendReuse(outOfBandInvitation: OutOfBandInvitation, connection: ConnectionRecord) {
    const message = new HandshakeReuseMessage({ parentThreadId: outOfBandInvitation.id })
    const outbound = createOutboundMessage(connection, message)
    await this.messageSender.sendMessage(outbound)
  }

  private registerHandlers(dispatcher: Dispatcher) {
    dispatcher.registerHandler(new HandshakeReuseHandler(this.logger))
  }
}
