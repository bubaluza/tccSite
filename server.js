const bodyParser = require('body-parser');
const express = require('express');
const SerialPort = require('serialport');
const Readline = require('@serialport/parser-readline');
const regression = require('regression');

const port = new SerialPort('COM3', {baudRate: 115200});
const parser = new Readline();
var dadoPronto = false;
var parsejson2;
var parsejson;
let i, maior, result;
let po=[], ponto=[], pontos=[], chav0=[], chav1=[];//vetores
let Vth, Voc, Isc, Vmp, Imp, Pmp, n, Io, Rso, Rsho, Rs, Rsh, Iph, FF, S0, S1, C;
let pcVoc = 0.9, pcIsc = 0.95, pcS0i = 0.8, pcS0f = 1, pcS1i = 0, pcS1f = 0.1;
let potencia;


port.pipe(parser);

const app = express();
app.use(express.static('.'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.listen(8080, function() {
    console.log('app started');
});

app.get('/ajaxSet', (req, res) => {
        resposta = {};
        resposta.chegou = false;
        port.write('a');
        res.send(resposta);
});

app.get('/ajaxMain', (req, res) => {
    if(dadoPronto){
        resposta = {};
        resposta.chegou = true;
        resposta.dadosIv = parsejson;
        resposta.pot = potencia;
        dadoPronto=false;
        res.send(resposta);
    }else{
        resposta = {};
        resposta.chegou = false;
        res.send(resposta);
    }
});


parser.on('data', line=> {
    const json = JSON.parse(line);
    console.log(json);
    if(json.data == true){
        po=[];
        potencia=[];
        chav0=[];
        chav1=[];
        pontos=[];
        parsejson = json.dataIv;
        parsejson2 = json.dataDin;
        for(let k=0;k<parsejson.length-1;k++){
            if(parsejson[k].voltage==-1){
                parsejson =parsejson.slice(0, k);
                break;
            }
        }

        for(i = 0; i < parsejson.length-1; i++)//calculo potencia
            po[i] = parsejson[i].voltage*parsejson[i].current
        for(i = 0; i < parsejson.length-1; i++){
            potencia[i] = {};
            potencia[i].voltage =parsejson[i].voltage;
            potencia[i].power = po[i];
        }
        i = 0;
        while(parsejson2[i].switching==0){
            chav0[i] = parsejson2[i];
            i++;
        }
        let j = 0;
        for(i; i<parsejson2.length; i++){
            chav1[j] = parsejson2[i];
            j++;
        }
        Voc = parsejson[0].voltage;
        Isc = parsejson[parsejson.length-1].current;
        Vth = 0.026;
        console.log(Voc);
        console.log(Isc);
        dadoPronto = true;
        extractRes();

    }

    // if(parsejson.terminouIv == true){
    //     port.write('a');
    //     dadoPronto = true;
    // }else if(parsejson.terminouData ==true){
    //
    // }
});


function extractRes(){
    console.log("\nTensao x Corrente para 10% Voc");
    pontos=[];
    console.log(Voc*pcVoc);
    for(i = 0; parsejson[i].voltage > (Voc*pcVoc); i++){
        let ponto =[];
        ponto[0] = parsejson[i].voltage;
        ponto[1] = parsejson[i].current;
        pontos.push(ponto);
        console.log(parsejson[i].voltage+" "+parsejson[i].current);
    }
    result = regression.linear(pontos, {precision: 5});
    Rsho = -1/result.equation[0];
    console.log("Rpo: "+Rsho);
    pontos=[];
    console.log("\nTensao x Corrente para 10% Isc");
    for(i=parsejson.length-1; parsejson[i].current > (Isc*pcIsc) ; i--){
        let ponto=[];
        ponto[0] = parsejson[i].voltage;
        ponto[1] = parsejson[i].current;
        pontos.push(ponto);
        console.log(parsejson[i].voltage+" "+parsejson[i].current);
    }
    result = regression.linear(pontos, {precision: 5});
    Rso = -1/result.equation[0];
    console.log("Rso: "+Rso);
    calcPmp();
    calcCelik();
}

function extractCap(){
    console.log("\nTempo x Tensão");
    for(i = 0; i < chav0.length*pcS0i; i++);
    for(i; i < chav0.length*pcS0f; i++){
        ponto[0] = chav0[i].time;
        ponto[1] = chav0[i].voltage;
        pontos.push(ponto.slice(0));
        console.log(chav0[i].time+" "+chav0[i].voltage);
    }
    result = regression.linear(pontos, {precision: 5});
    S0 = result.equation[0];
    for(i = 0; i < chav1.length*pcS1f; i++){
        ponto[0] = chav1[i].time;
        ponto[1] = chav1[i].voltage;
        pontos.push(ponto.slice(0));
        console.log(chav1[i].time+" "+chav1[i].voltage);
    }
    result = regression.linear(pontos, {precision: 5});
    S1 = result.equation[0];
    C = (-S0*0.000022)/(S0-S1);
    console.log("Capacitância interna: "+C);
}

function calcPmp(){
    for(i = 0; i < parsejson.length-1; i++){
        if(po[i] > po[i-1])
            maior = i;
        else break;
    }
    Vmp = parsejson[i].voltage;
    Imp = parsejson[i].current;
    Pmp = po[maior];
}

function calcCelik(){
    Rsh = Rsho;
    n = (Vmp+Rso*Imp-Voc)/(Vth*(Math.log(Isc-Vmp/Rsho-Imp)-Math.log(Isc-Voc/Rsh)+Imp/(Isc-Voc/Rsho)));
    Io = (Isc-Voc/Rsh)*Math.exp(-Voc/(n*Vth));
    Rs = Rso-n*Vth*Math.exp(-Voc/(n*Vth))/Io;
    Iph = Isc*(1+Rs/Rsh)+Io*(Math.exp(Isc*Rs/(n*Vth)-1));
    FF = (Vmp*Imp)/(Voc*Isc);
}
