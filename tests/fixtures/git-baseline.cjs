'use strict';
const {execFileSync}=require('node:child_process');
module.exports=function gitBaseline(workspace){
 const git=args=>execFileSync('/usr/bin/git',['-C',workspace,'-c','core.hooksPath=/dev/null',...args],{stdio:'pipe'});
 git(['init','-q']);require('node:fs').writeFileSync(require('node:path').join(workspace,'.gitignore'),'wire.log\n');git(['add','.gitignore']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','--allow-empty','-qm','Disposable baseline']);
};
