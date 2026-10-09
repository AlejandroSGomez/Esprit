/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs'),assert=require('node:assert/strict'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {JSDOM}=require('jsdom'),dom=new JSDOM('');global.DOMParser=dom.window.DOMParser;global.XMLSerializer=dom.window.XMLSerializer;
const {zipSync,strToU8,strFromU8,unzipSync}=require('fflate');
const {readWorkbook,writeWorkbook,translateFormula,serialDate}=require('../app/xlsx.ts');
assert.equal(translateFormula('SUM(A1,$A1,A$1,$A$1,A:A,$B:$B,1:1,$2:$2,"A1",\'Sheet 2\'!A1,Sheet1!B2,LOG10(A1),Table1[A1])','B1','C2'),'SUM(B2,$A2,B$1,$A$1,B:B,$B:$B,2:2,$2:$2,"A1",\'Sheet 2\'!B2,Sheet1!C3,LOG10(B2),Table1[A1])');
assert.equal(translateFormula('A1+B2','B2','A1'),'#REF!+A1');
assert.equal(serialDate(1,true),'1904-01-02');assert.equal(serialDate(1),'1900-01-01');assert.equal(serialDate(59),'1900-02-28');assert.equal(serialDate(60),'1900-02-29');assert.equal(serialDate(61),'1900-03-01');assert.equal(serialDate(1.5,true),'1904-01-02 12:00');
const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const fixture=(formula='<f t="shared" si="0" ref="B1:B3">A1*2</f>')=>zipSync(Object.fromEntries(Object.entries({
 'xl/workbook.xml':`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="Test" sheetId="1" r:id="rId1"/></sheets></workbook>`,
 'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
 'xl/worksheets/sheet1.xml':`<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1">${formula}<v>2</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>4</v></c></row><row r="3"><c r="B3"><f t="shared" si="0"/><v>6</v></c></row></sheetData></worksheet>`,
 'untouched.bin':'preserve bytes'
}).map(([k,v])=>[k,strToU8(v)])));
for(const ref of ['B1','B2']) {
 const book=readWorkbook(fixture());assert.equal(book.sheets[0].cells.get('B3').formula,'A3*2');
 const bytes=writeWorkbook(book,new Map([[0,new Map([[ref,'17']])]]));const next=readWorkbook(bytes);
 assert.equal(next.sheets[0].cells.get(ref).value,'17');assert.equal(next.sheets[0].cells.get('B3').formula,'A3*2');assert.equal(next.sheets[0].cells.get(ref==='B1'?'B2':'B1').formula,ref==='B1'?'A2*2':'A1*2');
 const files=unzipSync(bytes);assert.equal(strFromU8(files['untouched.bin']),'preserve bytes');assert.ok(!strFromU8(files['xl/worksheets/sheet1.xml']).includes('t="shared"'));
}
for(const f of ['<f t="array" ref="B1:B3">A1:A3*2</f>','<f t="shared" si="0"/>']) {const book=readWorkbook(fixture(f));assert.ok(book.sheets[0].editProblem);assert.throws(()=>writeWorkbook(book,new Map([[0,new Map([['B1','4']])]])));}
console.log('PASS: shared masters/followers, mixed references, ranges, dates 1900/1904, untouched parts, unsupported formulas protected.');
