# Homebrew formula for zn-gate, installed from the npm tarball.
# Template for the tap repository usezn/homebrew-tap (Formula/zn-gate.rb). The tap does not exist yet,
# so no `brew install` command for zn-gate works until it is created.
# The npm tarball bundles its dependencies in node_modules, so the install needs no network access.
class ZnGate < Formula
  desc "The local security layer for coding agents"
  homepage "https://usezn.com"
  url "https://registry.npmjs.org/zn-gate/-/zn-gate-1.17.0.tgz"
  sha256 "51b24e16bfab945151cc6fa13706e03343f01a087731b5d899864dc02c1d0c14"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (libexec/"bin/cli.js").chmod 0755
    %w[zn-gate zn zn-mcp].each do |name|
      bin.install_symlink libexec/"bin/cli.js" => name
    end
  end

  test do
    assert_match "1.17.0", shell_output("#{bin}/zn-gate --version")
  end
end
