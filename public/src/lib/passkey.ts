function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexFromText(value: string) {
  return bytesToHex(new TextEncoder().encode(value)).slice(0, 128).padEnd(16, '0')
}

function randomChallenge() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytes
}

export async function authenticatePasskeyProof(username: string) {
  const challenge = randomChallenge()
  const fallbackSeed = `${username}:${bytesToHex(challenge)}`

  if (!window.PublicKeyCredential || !navigator.credentials?.get) {
    return hexFromText(fallbackSeed)
  }

  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge,
        timeout: 60000,
        userVerification: 'preferred',
      },
    }) as PublicKeyCredential | null

    if (!credential) return hexFromText(fallbackSeed)
    return hexFromText(`${username}:${credential.id}`)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error('Passkey authentication was cancelled.')
    }
    throw new Error(error instanceof Error ? error.message : 'Passkey authentication failed.')
  }
}
