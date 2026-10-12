export interface ChatGptAttachment {
  name: string;
  mimeType: string;
  content: Buffer;
}

export interface ChatGptTransportRequest {
  title: string;
  outbound: string;
  attachments?: ChatGptAttachment[];
}

export interface ChatGptTransport {
  exchange(request: ChatGptTransportRequest): Promise<string>;
}
