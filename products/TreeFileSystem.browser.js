const GRAMMAR_EXTENSION = ".grammar"
const parserRegex = /^[a-zA-Z0-9_]+Parser/gm
// A regex to check if a multiline string has a line that starts with "import ".
const importRegex = /^import /gm
const importOnlyRegex = /^importOnly/
class DiskWriter {
  constructor() {
    this.fileCache = {}
  }
  _read(absolutePath) {
    const { fileCache } = this
    if (!fileCache[absolutePath]) fileCache[absolutePath] = { absolutePath, content: Disk.read(absolutePath).replace(/\r/g, ""), mtimeMs: fs.statSync(absolutePath) }
    return fileCache[absolutePath]
  }
  read(absolutePath) {
    return this._read(absolutePath).content
  }
  list(folder) {
    return Disk.getFiles(folder)
  }
  write(fullPath, content) {
    Disk.writeIfChanged(fullPath, content)
  }
  getMTime(absolutePath) {
    return this._read(absolutePath).mtimeMs
  }
  dirname(absolutePath) {
    return path.dirname(absolutePath)
  }
  join(...segments) {
    return path.join(...arguments)
  }
}
class MemoryWriter {
  constructor(inMemoryFiles) {
    this.inMemoryFiles = inMemoryFiles
  }
  read(absolutePath) {
    const value = this.inMemoryFiles[absolutePath]
    if (value === undefined) throw new Error(`File '${absolutePath}' not found.`)
    return value
  }
  write(absolutePath, content) {
    this.inMemoryFiles[absolutePath] = content
  }
  list(absolutePath) {
    return Object.keys(this.inMemoryFiles).filter(filePath => filePath.startsWith(absolutePath) && !filePath.replace(absolutePath, "").includes("/"))
  }
  getMTime() {
    return 1
  }
  dirname(path) {
    return posix.dirname(path)
  }
  join(...segments) {
    return posix.join(...arguments)
  }
}
class TreeFileSystem {
  constructor(inMemoryFiles) {
    this._treeCache = {}
    this._parserCache = {}
    this._expandedImportCache = {}
    this._grammarExpandersCache = {}
    if (inMemoryFiles) this._storage = new MemoryWriter(inMemoryFiles)
    else this._storage = new DiskWriter()
  }
  read(absolutePath) {
    return this._storage.read(absolutePath)
  }
  write(absolutePath, content) {
    return this._storage.write(absolutePath, content)
  }
  list(absolutePath) {
    return this._storage.list(absolutePath)
  }
  dirname(absolutePath) {
    return this._storage.dirname(absolutePath)
  }
  join(...segments) {
    return this._storage.join(...segments)
  }
  getMTime(absolutePath) {
    return this._storage.getMTime(absolutePath)
  }
  _getFileAsTree(absoluteFilePath) {
    const { _treeCache } = this
    if (_treeCache[absoluteFilePath] === undefined) {
      _treeCache[absoluteFilePath] = new TreeNode(this._storage.read(absoluteFilePath))
    }
    return _treeCache[absoluteFilePath]
  }
  _assembleFile(absoluteFilePath) {
    const { _expandedImportCache } = this
    if (_expandedImportCache[absoluteFilePath]) return _expandedImportCache[absoluteFilePath]
    let code = this.read(absoluteFilePath)
    const isImportOnly = importOnlyRegex.test(code)
    // Strip any parsers
    const stripIt = code.includes("// parsersOnly") // temporary perf hack
    if (stripIt)
      code = code
        .split("\n")
        .filter(line => line.startsWith("import "))
        .join("\n")
    const filepathsWithParserDefinitions = []
    if (this._doesFileHaveGrammarDefinitions(absoluteFilePath)) filepathsWithParserDefinitions.push(absoluteFilePath)
    if (!importRegex.test(code))
      return {
        afterImportPass: code,
        isImportOnly,
        importFilePaths: [],
        filepathsWithParserDefinitions
      }
    let importFilePaths = []
    const lines = code.split("\n")
    const replacements = []
    lines.forEach((line, lineNumber) => {
      const folder = this.dirname(absoluteFilePath)
      if (line.match(importRegex)) {
        const relativeFilePath = line.replace("import ", "")
        const absoluteImportFilePath = this.join(folder, relativeFilePath)
        const expandedFile = this._assembleFile(absoluteImportFilePath)
        importFilePaths.push(absoluteImportFilePath)
        importFilePaths = importFilePaths.concat(expandedFile.importFilePaths)
        replacements.push({ lineNumber, code: expandedFile.afterImportPass })
      }
    })
    replacements.forEach(replacement => {
      const { lineNumber, code } = replacement
      lines[lineNumber] = code
    })
    const combinedLines = lines.join("\n")
    _expandedImportCache[absoluteFilePath] = {
      importFilePaths,
      isImportOnly,
      afterImportPass: combinedLines,
      filepathsWithParserDefinitions: importFilePaths.filter(filename => this._doesFileHaveGrammarDefinitions(filename)).concat(filepathsWithParserDefinitions)
    }
    return _expandedImportCache[absoluteFilePath]
  }
  _doesFileHaveGrammarDefinitions(absoluteFilePath) {
    if (!absoluteFilePath) return false
    const { _grammarExpandersCache } = this
    if (_grammarExpandersCache[absoluteFilePath] === undefined) _grammarExpandersCache[absoluteFilePath] = !!this._storage.read(absoluteFilePath).match(parserRegex)
    return _grammarExpandersCache[absoluteFilePath]
  }
  _getOneGrammarParserFromFiles(filePaths, baseGrammarCode) {
    const parserDefinitionRegex = /^[a-zA-Z0-9_]+Parser/
    const asOneFile = filePaths
      .map(filePath => {
        const content = this._storage.read(filePath)
        if (filePath.endsWith(GRAMMAR_EXTENSION)) return content
        // Strip scroll content
        return new TreeNode(content)
          .filter(node => node.getLine().match(parserDefinitionRegex))
          .map(node => node.asString)
          .join("\n")
      })
      .join("\n")
      .trim()
    // todo: clean up jtree so we are using supported methods (perhaps add a formatOptions that allows you to tell Grammar not to run prettier on js nodes)
    return new grammarParser(baseGrammarCode + "\n" + asOneFile)._sortNodesByInScopeOrder()._sortWithParentParsersUpTop()
  }
  get parsers() {
    return Object.values(this._parserCache).map(parser => parser.grammarParser)
  }
  getParser(filePaths, baseGrammarCode = "") {
    const { _parserCache } = this
    const key = filePaths
      .filter(fp => fp)
      .sort()
      .join("\n")
    const hit = _parserCache[key]
    if (hit) return hit
    const grammarParser = this._getOneGrammarParserFromFiles(filePaths, baseGrammarCode)
    const grammarCode = grammarParser.asString
    _parserCache[key] = {
      grammarParser,
      grammarCode,
      parser: new HandGrammarProgram(grammarCode).compileAndReturnRootParser()
    }
    return _parserCache[key]
  }
  assembleFile(absoluteFilePath, defaultParserCode) {
    const assembledFile = this._assembleFile(absoluteFilePath)
    if (!defaultParserCode) return assembledFile
    // BUILD CUSTOM COMPILER, IF THERE ARE CUSTOM GRAMMAR NODES DEFINED
    if (assembledFile.filepathsWithParserDefinitions.length) assembledFile.parser = this.getParser(assembledFile.filepathsWithParserDefinitions, defaultParserCode).parser
    return assembledFile
  }
}
window.TreeFileSystem = TreeFileSystem
