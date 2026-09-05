export interface ChatGptTransportRequest {
  title: string;
  outbound: string;
}

export interface ChatGptTransport {
  exchange(request: ChatGptTransportRequest): Promise<string>;
}
