export interface PushSender {
  publicKey: string;
  send(endpoint: string, ttl: number): Promise<number>;
}
