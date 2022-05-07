import { JsonTransformer } from '../../../../../utils'
import { DidDocument } from '../../../domain'
import { didToNumAlgo2DidDocument, didDocumentToNumAlgo2Did, outOfBandServiceToNumAlgo2Did } from '../peerDidNumAlgo2'

import didPeer1zQmRDidCommServices from './__fixtures__/didPeer1zQmR-did-comm-service.json'
import didPeer2Ez6L from './__fixtures__/didPeer2Ez6L.json'
import didPeer2Ez6LMoreServices from './__fixtures__/didPeer2Ez6LMoreServices.json'

describe('peerDidNumAlgo2', () => {
  describe('didDocumentToNumAlgo2Did', () => {
    test('transforms method 2 peer did to a did document', async () => {
      expect(didToNumAlgo2DidDocument(didPeer2Ez6L.id).toJSON()).toMatchObject(didPeer2Ez6L)

      expect(didToNumAlgo2DidDocument(didPeer2Ez6LMoreServices.id).toJSON()).toMatchObject(didPeer2Ez6LMoreServices)
    })
  })

  describe('didDocumentToNumAlgo2Did', () => {
    test('transforms method 2 peer did document to a did', async () => {
      const expectedDid = didPeer2Ez6L.id

      const didDocument = JsonTransformer.fromJSON(didPeer2Ez6L, DidDocument)

      expect(didDocumentToNumAlgo2Did(didDocument)).toBe(expectedDid)
    })
  })

  describe('outOfBandServiceToNumAlgo2Did', () => {
    test('transforms a did comm service into a valid method 2 did', () => {
      const didDocument = JsonTransformer.fromJSON(didPeer1zQmRDidCommServices, DidDocument)
      const peerDid = outOfBandServiceToNumAlgo2Did(didDocument.didCommServices[0])
      const peerDidDocument = didToNumAlgo2DidDocument(peerDid)

      // TODO the following `console.log` statement throws an error "TypeError: Cannot read property 'toLowerCase'
      // of undefined" because of this:
      //
      // `service.id = `${did}#${service.type.toLowerCase()}-${serviceIndex++}``

      // console.log(peerDidInstance.didDocument)

      expect(peerDid).toBe(
        'did:peer:2.Ez6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH.SeyJzIjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9lbmRwb2ludCJ9'
      )
      expect(peerDid).toBe(peerDidDocument.id)
    })
  })
})
