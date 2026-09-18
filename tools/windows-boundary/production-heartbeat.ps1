param([string]$Pipe,[string]$Nonce,[string]$Deployment,[string]$Project)
$ErrorActionPreference = 'Stop'
$client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $Pipe, [System.IO.Pipes.PipeDirection]::InOut,
  [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Impersonation)
try {
  $client.Connect(2000)
  $writer = [System.IO.StreamWriter]::new($client)
  $writer.AutoFlush = $true
  $writer.WriteLine((@{verb='heartbeat'; nonce=$Nonce; deployment=$Deployment; project=$Project} | ConvertTo-Json -Compress))
  $reader = [System.IO.StreamReader]::new($client)
  $reader.ReadLine()
} finally { $client.Dispose() }
