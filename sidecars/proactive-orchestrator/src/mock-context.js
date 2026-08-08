export function createMockScreenpipeContext(){
  return [
    {
      timestamp: new Date().toISOString(),
      app: 'VS Code',
      windowTitle: 'arcana-main - Visual Studio Code',
      text: 'npm ERR! TypeError: Cannot read properties of undefined (reading "sessionId")',
      source: 'mock',
      evidenceId: 'mock-vscode-001',
      privacyFlags: [],
    },
    {
      timestamp: new Date().toISOString(),
      app: 'Chrome',
      windowTitle: 'Arcana docs - Chrome',
      text: 'User is reviewing requirements for proactive screen-aware agent suggestions.',
      source: 'mock',
      evidenceId: 'mock-chrome-001',
      privacyFlags: [],
    },
  ];
}
