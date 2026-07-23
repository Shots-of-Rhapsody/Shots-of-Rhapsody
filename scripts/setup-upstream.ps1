[CmdletBinding()]
param(
	[switch]$Fetch
)

$ErrorActionPreference = "Stop"

$repositoryRootOutput = @(& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or $repositoryRootOutput.Count -eq 0) {
	throw "Run this script from inside a Git working tree."
}

$script:RepositoryRoot = (Resolve-Path -LiteralPath $repositoryRootOutput[0]).Path
$upstreamFetchUrl = "https://github.com/saicaca/fuwari.git"
$upstreamDisabledPushUrl = "https://upstream-push-disabled.invalid/saicaca/fuwari.git"

function Invoke-RepositoryGit {
	param(
		[Parameter(Mandatory = $true)]
		[string[]]$GitArguments
	)

	$output = @(& git -C $script:RepositoryRoot @GitArguments)
	if ($LASTEXITCODE -ne 0) {
		throw "git $($GitArguments -join ' ') failed with exit code $LASTEXITCODE."
	}

	return $output
}

$remoteNames = @(Invoke-RepositoryGit -GitArguments @("remote"))
if ($remoteNames -notcontains "origin") {
	throw "The repository must already have an origin remote. This script never creates or rewrites origin."
}

if ($remoteNames -contains "upstream") {
	Invoke-RepositoryGit -GitArguments @("remote", "set-url", "upstream", $upstreamFetchUrl) | Out-Null
} else {
	Invoke-RepositoryGit -GitArguments @("remote", "add", "-t", "main", "upstream", $upstreamFetchUrl) | Out-Null
}

Invoke-RepositoryGit -GitArguments @("remote", "set-branches", "upstream", "main") | Out-Null
Invoke-RepositoryGit -GitArguments @(
	"config",
	"--local",
	"--replace-all",
	"remote.upstream.fetch",
	"+refs/heads/main:refs/remotes/upstream/main"
) | Out-Null
Invoke-RepositoryGit -GitArguments @(
	"config",
	"--local",
	"--replace-all",
	"remote.upstream.pushurl",
	$upstreamDisabledPushUrl
) | Out-Null
Invoke-RepositoryGit -GitArguments @("config", "--local", "remote.pushDefault", "origin") | Out-Null
Invoke-RepositoryGit -GitArguments @("config", "--local", "branch.main.pushRemote", "origin") | Out-Null

$configuredFetchUrl = @(Invoke-RepositoryGit -GitArguments @("remote", "get-url", "upstream"))[0]
$configuredPushUrl = @(Invoke-RepositoryGit -GitArguments @("remote", "get-url", "--push", "upstream"))[0]
$configuredFetchRefspec = @(
	Invoke-RepositoryGit -GitArguments @("config", "--local", "--get", "remote.upstream.fetch")
)[0]

if ($configuredFetchUrl -ne $upstreamFetchUrl) {
	throw "Unexpected upstream fetch URL: $configuredFetchUrl"
}
if ($configuredPushUrl -ne $upstreamDisabledPushUrl) {
	throw "Unexpected upstream push URL: $configuredPushUrl"
}
if ($configuredFetchRefspec -ne "+refs/heads/main:refs/remotes/upstream/main") {
	throw "Unexpected upstream fetch refspec: $configuredFetchRefspec"
}

if ($Fetch) {
	Invoke-RepositoryGit -GitArguments @("fetch", "upstream", "--prune") | Out-Null
}

Write-Host "Configured origin as the default push remote."
Write-Host "Configured upstream to fetch only saicaca/fuwari main."
Write-Host "Configured upstream push URL as intentionally invalid."
if (-not $Fetch) {
	Write-Host "Run again with -Fetch, or run 'git fetch upstream --prune', when network access is desired."
}
