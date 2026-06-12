export interface FeedbackRequest {
  email: string;
  issueType: string;
  severity: string;
  description: string;
  steps?: string;
  systemInfo: {
    timestamp: string;
    userAgent: string;
    screenResolution: string;
    language: string;
    currentPath: string;
    fhirServerUrl: string;
    patientId: string;
  };
}
