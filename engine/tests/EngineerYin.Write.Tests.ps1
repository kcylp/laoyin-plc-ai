$modulePath = Join-Path $PSScriptRoot '..\src\EngineerYin.Write.psm1'
Import-Module $modulePath -Force

Describe 'EngineerYin.Write recursive block lookup' {
    It 'finds a root block and returns its full path' {
        $rootBlock = [pscustomobject]@{ Name = 'RootBlock' }
        $root = [pscustomobject]@{ Blocks = @($rootBlock); Groups = @() }

        $actual = & (Get-Module EngineerYin.Write) {
            param($Group)
            Resolve-YinBlockForExport -Group $Group -BlockName 'RootBlock'
        } $root

        $actual.Block | Should Be $rootBlock
        $actual.Path | Should Be 'RootBlock'
    }

    It 'finds a block stored in multiple nested groups' {
        $target = [pscustomobject]@{ Name = 'NestedBlock' }
        $inner = [pscustomobject]@{ Name = 'Inner'; Blocks = @($target); Groups = @() }
        $outer = [pscustomobject]@{ Name = 'Outer'; Blocks = @(); Groups = @($inner) }
        $root = [pscustomobject]@{ Blocks = @(); Groups = @($outer) }

        $actual = & (Get-Module EngineerYin.Write) {
            param($Group)
            Resolve-YinBlockForExport -Group $Group -BlockName 'NestedBlock'
        } $root

        $actual.Block | Should Be $target
        $actual.Path | Should Be 'Outer/Inner/NestedBlock'
    }

    It 'rejects an absent block with a clear error' {
        $root = [pscustomobject]@{ Blocks = @(); Groups = @() }
        $message = ''
        try {
            & (Get-Module EngineerYin.Write) { param($Group) Resolve-YinBlockForExport -Group $Group -BlockName 'Missing' } $root
        } catch {
            $message = $_.Exception.Message
        }
        $message | Should Be "Block 'Missing' not found."
    }

    It 'rejects duplicate names unless a full block path is supplied' {
        $first = [pscustomobject]@{ Name = 'Duplicate' }
        $second = [pscustomobject]@{ Name = 'Duplicate' }
        $left = [pscustomobject]@{ Name = 'Left'; Blocks = @($first); Groups = @() }
        $right = [pscustomobject]@{ Name = 'Right'; Blocks = @($second); Groups = @() }
        $root = [pscustomobject]@{ Blocks = @(); Groups = @($left, $right) }

        $message = ''
        try {
            & (Get-Module EngineerYin.Write) { param($Group) Resolve-YinBlockForExport -Group $Group -BlockName 'Duplicate' } $root
        } catch {
            $message = $_.Exception.Message
        }
        $message | Should Be "Block 'Duplicate' is ambiguous. Supply -BlockPath. Candidates: Left/Duplicate, Right/Duplicate"

        $actual = & (Get-Module EngineerYin.Write) {
            param($Group)
            Resolve-YinBlockForExport -Group $Group -BlockName 'Duplicate' -BlockPath 'Right/Duplicate'
        } $root
        $actual.Block | Should Be $second
        $actual.Path | Should Be 'Right/Duplicate'
    }
}
